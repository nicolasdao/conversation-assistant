import AVFoundation
import CoreMedia
import Foundation
import Speech

let pcm16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

func milliseconds(_ t: CMTime) -> Double { t.seconds * 1000 }

/// A buffer of 16 kHz PCM16 in the analyzer's format, converted when it differs (it does not on macOS 26.2).
func makeBuffer(_ samples: [Int16], format: AVAudioFormat, converter: AVAudioConverter?) -> AVAudioPCMBuffer? {
    guard let buf = AVAudioPCMBuffer(pcmFormat: pcm16, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
    buf.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { src in buf.int16ChannelData![0].update(from: src.baseAddress!, count: samples.count) }
    guard let converter else { return buf }
    let capacity = AVAudioFrameCount(Double(samples.count) * format.sampleRate / 16000) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, state in
        if given { state.pointee = .noDataNow; return nil }
        given = true
        state.pointee = .haveData
        return buf
    }
    return error == nil ? out : nil
}

/// Runs with an audio time range, in session milliseconds.
func timedRuns(_ text: AttributedString) -> [[String: Any]] {
    var runs: [[String: Any]] = []
    for run in text.runs {
        guard let range = run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self] else { continue }
        runs.append(["text": String(text[run.range].characters), "startMs": milliseconds(range.start), "endMs": milliseconds(CMTimeRangeGetEnd(range))])
    }
    return runs
}

/// One stream's analyzer for live text: volatile and final results as they come, never finalized mid-stream.
final class LiveStream: @unchecked Sendable {
    let name: String
    private let analyzer: SpeechAnalyzer
    private let format: AVAudioFormat
    private let converter: AVAudioConverter?
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private let reader: Task<Void, Never>

    private init(name: String, analyzer: SpeechAnalyzer, format: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation, reader: Task<Void, Never>) {
        self.name = name
        self.analyzer = analyzer
        self.format = format
        converter = format == pcm16 ? nil : AVAudioConverter(from: pcm16, to: format)
        self.input = input
        self.reader = reader
    }

    static func start(index: Int, locale: Locale) async throws -> LiveStream {
        let name = index == 0 ? "host" : "remote"
        let transcriber = makeTranscriber(locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: pcm16) else {
            throw FrameError(description: "no audio format for \(name)")
        }
        try await analyzer.prepareToAnalyze(in: format)
        let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
        let reader = Task {
            do {
                for try await result in transcriber.results {
                    let runs = timedRuns(result.text)
                    if runs.isEmpty { continue }
                    emit(["type": result.isFinal ? "final" : "volatile", "stream": name, "runs": runs])
                }
            } catch {
                emit(["type": "error", "message": "\(name) live text: \(describe(error))", "fatal": false])
            }
        }
        try await analyzer.start(inputSequence: stream)
        return LiveStream(name: name, analyzer: analyzer, format: format, input: input, reader: reader)
    }

    func feed(startMs: Double, samples: [Int16]) {
        guard let buf = makeBuffer(samples, format: format, converter: converter) else { return }
        input.yield(AnalyzerInput(buffer: buf, bufferStartTime: CMTime(value: CMTimeValue((startMs * 16).rounded()), timescale: 16000)))
    }

    func finish() async {
        input.finish()
        do { try await analyzer.finalizeAndFinishThroughEndOfInput() } catch {
            status(["type": "warning", "message": "\(name) finish: \(describe(error))"])
        }
        await reader.value
    }
}

struct Clip: Sendable {
    let id: String
    let startSample: Int
    let samples: [Int16]
}

/// Clips in arrival order, at most `concurrency` at once, each in its own short-lived analyzer.
final class ClipQueue: @unchecked Sendable {
    private let locale: Locale
    private let input: AsyncStream<Clip>.Continuation
    private let runner: Task<Void, Never>

    init(locale: Locale, concurrency: Int) {
        self.locale = locale
        let (stream, input) = AsyncStream<Clip>.makeStream()
        self.input = input
        runner = Task {
            await withTaskGroup(of: Void.self) { group in
                var running = 0
                for await clip in stream {
                    if running >= concurrency { await group.next(); running -= 1 }
                    group.addTask {
                        do {
                            emit(["type": "clip", "id": clip.id, "text": try await transcribeClip(clip, locale: locale)])
                        } catch {
                            emit(["type": "clip", "id": clip.id, "error": describe(error)])
                        }
                    }
                    running += 1
                }
            }
        }
    }

    func warmUp() async {
        _ = try? await transcribeClip(Clip(id: "warm-up", startSample: 0, samples: [Int16](repeating: 0, count: 16_000)), locale: locale)
    }

    func enqueue(_ clip: Clip) { input.yield(clip) }

    func finish() async {
        input.finish()
        await runner.value
    }
}

/// Someone is waiting for each clip. The model's retention stays the default: `.lingering` and `.processLifetime` each
/// made a later clip never answer (measured); the idle analyzer in main.swift keeps the model loaded instead.
let clipOptions = SpeechAnalyzer.Options(priority: .userInitiated, modelRetention: .whileInUse)

func transcribeClip(_ clip: Clip, locale: Locale) async throws -> String {
    let transcriber = makeTranscriber(locale)
    let analyzer = SpeechAnalyzer(modules: [transcriber], options: clipOptions)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: pcm16) else {
        throw FrameError(description: "no audio format")
    }
    let converter = format == pcm16 ? nil : AVAudioConverter(from: pcm16, to: format)
    guard let buf = makeBuffer(clip.samples, format: format, converter: converter) else { throw FrameError(description: "bad clip audio") }
    let reader = Task { () throws -> String in
        var text = ""
        for try await result in transcriber.results where result.isFinal {
            text += String(result.text.characters)
        }
        return text
    }
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    input.yield(AnalyzerInput(buffer: buf, bufferStartTime: CMTime(value: CMTimeValue(clip.startSample), timescale: 16000)))
    input.finish()
    do {
        _ = try await analyzer.analyzeSequence(stream)
        try await analyzer.finalizeAndFinishThroughEndOfInput()
    } catch {
        reader.cancel()
        throw error
    }
    return try await reader.value.trimmingCharacters(in: .whitespacesAndNewlines)
}
