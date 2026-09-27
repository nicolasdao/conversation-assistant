import AVFoundation
import Darwin
import Foundation

/// Where 16 kHz PCM16 frames go: stdout, or nowhere (probe mode).
protocol FrameSink: AnyObject {
    func frame(stream: UInt8, sessionMs: Double, samples: [Int16])
}

/// Converts any float PCM buffer (channel 0) to 16 kHz mono Float32.
final class MonoConverter {
    static let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private let monoFormat: AVAudioFormat
    private let converter: AVAudioConverter

    init?(sourceRate: Double) {
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sourceRate, channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: mono, to: MonoConverter.outFormat) else { return nil }
        monoFormat = mono
        converter = conv
    }

    /// Downmixes to mono by taking channel 0, then resamples.
    func convert(_ input: AVAudioPCMBuffer) -> [Float] {
        let n = Int(input.frameLength)
        guard n > 0, let data = input.floatChannelData,
              let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(n)) else { return [] }
        mono.frameLength = AVAudioFrameCount(n)
        let stride = input.format.isInterleaved ? Int(input.format.channelCount) : 1
        let src = data[0]
        let dst = mono.floatChannelData![0]
        for i in 0..<n { dst[i] = src[i * stride] }
        let capacity = AVAudioFrameCount(Double(n) * 16_000 / monoFormat.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: MonoConverter.outFormat, frameCapacity: capacity) else { return [] }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return mono
        }
        if error != nil { return [] }
        return Array(UnsafeBufferPointer(start: out.floatChannelData![0], count: Int(out.frameLength)))
    }
}

/// A MonoConverter that follows the input: when buffers arrive at a new sample rate (a Bluetooth headset switching
/// to its call profile, an output device change), it rebuilds for that rate instead of resampling from a stale one.
final class AdaptiveConverter {
    private var current: MonoConverter?
    private var rate: Double = 0

    func convert(_ input: AVAudioPCMBuffer) -> [Float] {
        let r = input.format.sampleRate
        guard r > 0 else { return [] }
        if r != rate || current == nil {
            current = MonoConverter(sourceRate: r)
            rate = r
        }
        return current?.convert(input) ?? []
    }
}

/// Level statistics for --probe.
struct Levels {
    var peak: Float = 0
    var sumSquares: Double = 0
    var count: Int = 0

    mutating func add(_ s: [Float]) {
        for x in s {
            let a = abs(x)
            if a > peak { peak = a }
            sumSquares += Double(x) * Double(x)
        }
        count += s.count
    }

    var json: [String: Any] {
        let db = { (v: Double) -> Double in v > 0 ? (20 * log10(v) * 10).rounded() / 10 : -120 }
        return ["peakDbfs": db(Double(peak)), "rmsDbfs": db(count > 0 ? sqrt(sumSquares / Double(count)) : 0), "samples": count]
    }
}

/// ClockLock: sample index / 16 = session milliseconds on both streams.
/// Session time starts at zero when capture starts (mach_absolute_time). Each buffer's first sample is placed at its
/// host time; a stream that falls more than 20 ms behind gets silence, one that runs more than 20 ms ahead loses samples.
final class ClockLock {
    static let samplesPerMs = 16
    static let toleranceSamples: Int64 = 20 * 16
    static let frameSamples = 1600

    let queue = DispatchQueue(label: "conversation-capture.clocklock")
    let startHost: UInt64
    let epochMs: Double
    private let timebase: mach_timebase_info_data_t
    private let sink: FrameSink
    private var emitted: [UInt8: Int64] = [:]
    private var pending: [UInt8: [Int16]] = [:]
    private(set) var levels: [UInt8: Levels] = [:]
    private var timer: DispatchSourceTimer?

    init(streams: [UInt8], sink: FrameSink) {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        timebase = tb
        self.sink = sink
        startHost = mach_absolute_time()
        epochMs = Date().timeIntervalSince1970 * 1000
        for s in streams {
            emitted[s] = 0
            pending[s] = []
            levels[s] = Levels()
        }
    }

    func ms(hostTime: UInt64) -> Double {
        let delta = Double(Int64(bitPattern: hostTime &- startHost))
        return delta * Double(timebase.numer) / Double(timebase.denom) / 1_000_000
    }

    var nowMs: Double { ms(hostTime: mach_absolute_time()) }

    /// Called from audio callbacks with already-converted 16 kHz samples.
    func push(stream: UInt8, samples: [Float], hostTime: UInt64) {
        queue.async { self.place(stream: stream, samples: samples, atMs: self.ms(hostTime: hostTime)) }
    }

    private func place(stream: UInt8, samples: [Float], atMs: Double) {
        guard var n = emitted[stream] else { return }
        levels[stream]?.add(samples)
        let target = Int64((atMs * Double(ClockLock.samplesPerMs)).rounded())
        let diff = target - n
        var slice = samples[...]
        if diff > ClockLock.toleranceSamples {
            append(stream, [Int16](repeating: 0, count: Int(diff)))
            n += diff
        } else if diff < -ClockLock.toleranceSamples {
            slice = slice.dropFirst(min(Int(-diff), slice.count))
        }
        append(stream, slice.map { Int16(max(-1, min(1, $0)) * ($0 < 0 ? 32768 : 32767)) })
    }

    private func append(_ stream: UInt8, _ s: [Int16]) {
        guard !s.isEmpty else { return }
        var p = pending[stream]!
        p.append(contentsOf: s)
        var n = emitted[stream]!
        n += Int64(s.count)
        emitted[stream] = n
        var start = n - Int64(p.count)
        while p.count >= ClockLock.frameSamples {
            sink.frame(stream: stream, sessionMs: Double(start) / Double(ClockLock.samplesPerMs), samples: Array(p[0..<ClockLock.frameSamples]))
            p.removeFirst(ClockLock.frameSamples)
            start += Int64(ClockLock.frameSamples)
        }
        pending[stream] = p
    }

    /// A stalled stream (no buffers for 300 ms, for example during a device rebuild) is padded with silence up to
    /// 100 ms ago, so the engine's stream merge never waits on it. A late buffer then counts as ahead and is trimmed.
    func startWatchdog() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let now = self.nowMs
            for (s, n) in self.emitted {
                let lagMs = now - Double(n) / Double(ClockLock.samplesPerMs)
                if lagMs > 300 {
                    let fill = Int64(((now - 100) * Double(ClockLock.samplesPerMs)).rounded()) - n
                    if fill > 0 { self.append(s, [Int16](repeating: 0, count: Int(fill))) }
                }
            }
        }
        t.resume()
        timer = t
    }

    /// Emits what is pending as a final short frame per stream.
    func flush() {
        queue.sync {
            timer?.cancel()
            for (s, p) in pending where !p.isEmpty {
                let n = emitted[s]!
                sink.frame(stream: s, sessionMs: Double(n - Int64(p.count)) / Double(ClockLock.samplesPerMs), samples: p)
                pending[s] = []
            }
        }
    }
}
