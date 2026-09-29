// tattle-transcribe: on-device transcription with Apple's SpeechAnalyzer (macOS 26+).
//
//   tattle-transcribe --status [--locale en-US]
//   tattle-transcribe --install [--locale en-US]
//   tattle-transcribe [--locale en-US] [--live] [--clip-concurrency 2]
//
// Run mode reads framed clips (and, with --live, audio) on stdin and writes JSON lines to stdout; diagnostics go to
// stderr. Final text comes from clips: each utterance gets its own short-lived analyzer. The stream analyzers (--live)
// only feed live text and are never finalized mid-stream, because finalize(through:) drops the words that follow it.
import AVFoundation
import CoreMedia
import Darwin
import Foundation
import Speech

signal(SIGPIPE, SIG_IGN)

// ---------- output ----------

let outLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    outLock.lock()
    FileHandle.standardOutput.write(data + Data("\n".utf8))
    outLock.unlock()
}

func status(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    FileHandle.standardError.write(data + Data("\n".utf8))
}

func fail(_ message: String, code: Int32) -> Never {
    emit(["type": "error", "message": message, "fatal": true])
    exit(code)
}

func describe(_ error: Error) -> String {
    if let e = error as? SFSpeechError, e.code == SFSpeechError.Code.insufficientResources {
        return "insufficient resources: too many speech analyses at once (\(error.localizedDescription))"
    }
    return error.localizedDescription
}

// ---------- arguments ----------

enum Mode: Sendable { case run, status, install }

struct Options: Sendable {
    var mode = Mode.run
    var localeId = "en-US"
    var live = false
    var clipConcurrency = 2
}

let opts: Options = {
    var o = Options()
    var args = CommandLine.arguments.dropFirst()
    while let a = args.popFirst() {
        switch a {
        case "--status": o.mode = .status
        case "--install": o.mode = .install
        case "--live": o.live = true
        case "--locale":
            guard let v = args.popFirst() else { fail("--locale needs a value", code: 64) }
            o.localeId = v
        case "--clip-concurrency":
            guard let v = args.popFirst().flatMap(Int.init), v >= 1 else { fail("--clip-concurrency needs a number ≥ 1", code: 64) }
            o.clipConcurrency = v
        case "-h", "--help":
            print("usage: tattle-transcribe --status | --install | [--live] [--locale en-US] [--clip-concurrency 2]")
            exit(0)
        default: fail("unknown argument \(a)", code: 64)
        }
    }
    return o
}()

func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [.audioTimeRange])
}

/// The supported locale equivalent to --locale, or nil.
func resolveLocale() async -> Locale? {
    await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: opts.localeId))
}

// ---------- --status ----------

func runStatus() async -> Int32 {
    guard SpeechTranscriber.isAvailable else {
        emit(["available": false, "reason": "Speech recognition is not available on this Mac", "locale": NSNull(), "installed": false])
        return 0
    }
    guard let locale = await resolveLocale() else {
        emit(["available": false, "reason": "\(opts.localeId) is not supported", "locale": NSNull(), "installed": false])
        return 0
    }
    let state = await AssetInventory.status(forModules: [makeTranscriber(locale)])
    emit(["available": true, "reason": NSNull(), "locale": locale.identifier, "installed": state == .installed])
    return 0
}

// ---------- --install ----------

func runInstall() async -> Int32 {
    guard SpeechTranscriber.isAvailable, let locale = await resolveLocale() else {
        emit(["type": "error", "message": "on-device speech recognition is not available for \(opts.localeId)"])
        return 2
    }
    do {
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [makeTranscriber(locale)]) else {
            emit(["type": "installed"])
            return 0
        }
        let progress = request.progress
        let reporter = Task {
            var last = -1.0
            while !Task.isCancelled {
                let f = progress.fractionCompleted
                if f != last { emit(["type": "progress", "fraction": f]); last = f }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        try await request.downloadAndInstall()
        reporter.cancel()
        emit(["type": "installed"])
        return 0
    } catch {
        emit(["type": "error", "message": describe(error)])
        return 1
    }
}

// ---------- run ----------

func runTranscribe() async -> Int32 {
    guard SpeechTranscriber.isAvailable, let locale = await resolveLocale() else {
        fail("on-device speech recognition is not available for \(opts.localeId)", code: 2)
    }
    guard await AssetInventory.status(forModules: [makeTranscriber(locale)]) == .installed else {
        fail("model not installed", code: 3)
    }
    var streams: [LiveStream] = []
    do {
        if opts.live {
            for index in 0..<2 { streams.append(try await LiveStream.start(index: index, locale: locale)) }
        } else {
            // an analyzer that is started and never fed holds the model between clips: without one, a clip's p90 was
            // 2.1 s and its max 3.4 s, against 0.7 s and 0.8 s with it (30 clips each, measured)
            streams.append(try await LiveStream.start(index: 0, locale: locale))
        }
    } catch {
        fail("could not start on-device transcription: \(describe(error))", code: 1)
    }
    let clips = ClipQueue(locale: locale, concurrency: opts.clipConcurrency)
    // The first clip starts cold (11 s measured); warm it up before saying ready.
    await clips.warmUp()
    emit(["type": "ready", "locale": locale.identifier])

    // stdin is read on its own thread: FileHandle reads block.
    let done = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
        let reader = FrameReader()
        while true {
            let data = FileHandle.standardInput.availableData
            if data.isEmpty { break }
            do {
                try reader.push(data) { frame in
                    switch frame {
                    case let .audio(stream, startMs, samples):
                        if opts.live { streams[stream].feed(startMs: startMs, samples: samples) }
                    case let .clip(id, samples):
                        clips.enqueue(Clip(id: id, startSample: 0, samples: samples))
                    case let .clipFile(id, path):
                        let url = URL(fileURLWithPath: path)
                        let data = try? Data(contentsOf: url)
                        try? FileManager.default.removeItem(at: url)
                        guard let data, data.count % 2 == 0 else {
                            emit(["type": "clip", "id": id, "error": "could not read the clip's audio"])
                            break
                        }
                        let samples = data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }.map { Int16(littleEndian: $0) }
                        clips.enqueue(Clip(id: id, startSample: 0, samples: samples))
                    }
                }
            } catch {
                fail("bad input: \(error)", code: 65)
            }
        }
        done.signal()
    }
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().async { done.wait(); c.resume() }
    }
    await clips.finish()
    for s in streams { await s.finish() }
    return 0
}

let code: Int32
switch opts.mode {
case .status: code = await runStatus()
case .install: code = await runInstall()
case .run: code = await runTranscribe()
}
exit(code)
