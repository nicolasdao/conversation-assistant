import AVFoundation
import Darwin
import Foundation
import Testing
@testable import tattle_capture

/// Collects frames instead of writing them to stdout.
final class Collect: FrameSink {
    struct Frame { let stream: UInt8; let sessionMs: Double; let samples: [Int16] }
    var frames: [Frame] = []
    func frame(stream: UInt8, sessionMs: Double, samples: [Int16]) { frames.append(Frame(stream: stream, sessionMs: sessionMs, samples: samples)) }
    func of(_ s: UInt8) -> [Frame] { frames.filter { $0.stream == s } }
    func samples(_ s: UInt8) -> [Int16] { of(s).flatMap(\.samples) }
}

/// The host time `ms` milliseconds after the clock started.
func host(_ c: ClockLock, _ ms: Double) -> UInt64 {
    var tb = mach_timebase_info_data_t()
    mach_timebase_info(&tb)
    return c.startHost &+ UInt64(ms * 1e6 * Double(tb.denom) / Double(tb.numer))
}

/// A float buffer at `rate`, `n` frames, `channels` interleaved or not, each channel filled with its value.
func buffer(rate: Double, n: Int, values: [Float], interleaved: Bool = false) -> AVAudioPCMBuffer {
    let f = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: AVAudioChannelCount(values.count), interleaved: interleaved)!
    let b = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: AVAudioFrameCount(n))!
    b.frameLength = AVAudioFrameCount(n)
    if interleaved {
        let p = b.floatChannelData![0]
        for i in 0..<n { for (c, v) in values.enumerated() { p[i * values.count + c] = v } }
    } else {
        for (c, v) in values.enumerated() { for i in 0..<n { b.floatChannelData![c][i] = v * sinf(Float(i) / 8) + v } }
    }
    return b
}

@Suite struct LevelsTests {
    @Test func silenceIsMinus120() {
        let j = Levels().json
        #expect(j["peakDbfs"] as? Double == -120)
        #expect(j["rmsDbfs"] as? Double == -120)
        #expect(j["samples"] as? Int == 0)
    }

    @Test func fullScaleIsZeroDbfs() {
        var l = Levels()
        l.add([1, -1])
        #expect(l.json["peakDbfs"] as? Double == 0)
        #expect(l.json["rmsDbfs"] as? Double == 0)
        #expect(l.json["samples"] as? Int == 2)
    }

    @Test func roundsToATenthOfADecibel() {
        var l = Levels()
        l.add([0.5, -0.25])
        #expect(l.json["peakDbfs"] as? Double == -6)   // 20·log10(0.5) = −6.02
        #expect(l.json["rmsDbfs"] as? Double == -8.1)  // √((0.25 + 0.0625) / 2) = 0.395 → −8.06
    }
}

@Suite struct ClockLockTests {
    @Test func flushEmitsPendingAsAShortFrame() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [Float](repeating: 0.5, count: 100), hostTime: c.startHost)
        c.flush()
        #expect(sink.frames.count == 1)
        #expect(sink.frames[0].sessionMs == 0)
        #expect(sink.frames[0].samples.count == 100)
    }

    @Test func padsALateStreamWithSilence() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [Float](repeating: 0.5, count: 1600), hostTime: host(c, 500))
        c.flush()
        let s = sink.samples(0)
        #expect(s.count == 8000 + 1600)
        #expect(s[0..<8000].allSatisfy { $0 == 0 })
        #expect(s[8000...].allSatisfy { $0 == 16383 })
        #expect(sink.of(0).map(\.sessionMs) == [0, 100, 200, 300, 400, 500])
    }

    @Test func withinToleranceNoPadding() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [Float](repeating: 0.1, count: 10), hostTime: host(c, 19))
        c.flush()
        #expect(sink.samples(0).count == 10)
    }

    @Test func clampsAndScalesToInt16() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [2, -2, 1, -1, 0], hostTime: c.startHost)
        c.flush()
        #expect(sink.samples(0) == [32767, -32768, 32767, -32768, 0])
    }

    @Test func unknownStreamIsIgnored() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 7, samples: [0.5, 0.5], hostTime: c.startHost)
        c.flush()
        #expect(sink.frames.isEmpty)
        #expect(c.levels[7] == nil)
    }

    @Test func trimsAStreamThatRunsAhead() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [Float](repeating: 0.5, count: 1600), hostTime: host(c, 500)) // now at 600 ms
        c.push(stream: 0, samples: [Float](repeating: 0.25, count: 1600), hostTime: c.startHost) // 600 ms ahead: all dropped
        c.flush()
        #expect(sink.samples(0).count == 9600)
        #expect(!sink.samples(0).contains(8191))
    }

    @Test func dropsOnlyTheSamplesThatRunAhead() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [Float](repeating: 0.5, count: 1600), hostTime: c.startHost) // 0–100 ms
        c.push(stream: 0, samples: [Float](repeating: 0.25, count: 1600), hostTime: host(c, 50)) // 50 ms ahead: 800 dropped
        c.flush()
        #expect(sink.samples(0).count == 1600 + 800)
        #expect(sink.samples(0).filter { $0 == 8191 }.count == 800)
    }

    @Test func framesCarryContinuousSessionMs() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [Float](repeating: 0.1, count: 3200), hostTime: c.startHost)
        c.push(stream: 0, samples: [Float](repeating: 0.1, count: 800), hostTime: host(c, 200))
        c.flush()
        #expect(sink.of(0).map(\.sessionMs) == [0, 100, 200])
        #expect(sink.of(0).map(\.samples.count) == [1600, 1600, 800])
    }

    @Test func twoStreamsAreIndependent() {
        let sink = Collect()
        let c = ClockLock(streams: [0, 1], sink: sink)
        c.push(stream: 0, samples: [Float](repeating: 0.1, count: 1600), hostTime: c.startHost)
        c.push(stream: 1, samples: [Float](repeating: 0.2, count: 1600), hostTime: host(c, 300))
        c.flush()
        #expect(sink.samples(0).count == 1600)
        #expect(sink.samples(1).count == 4800 + 1600)
        #expect(sink.of(1).map(\.sessionMs) == [0, 100, 200, 300])
        #expect(c.levels[0]!.count == 1600 && c.levels[1]!.count == 1600)
    }

    @Test func flushTwiceEmitsNothingNew() {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.push(stream: 0, samples: [0.1, 0.2], hostTime: c.startHost)
        c.flush()
        c.flush()
        #expect(sink.frames.count == 1)
    }

    @Test func startHostIsSessionZero() {
        let c = ClockLock(streams: [0], sink: Collect())
        #expect(c.ms(hostTime: c.startHost) == 0)
        #expect(abs(c.ms(hostTime: host(c, 250)) - 250) < 0.01)
        #expect(c.nowMs >= 0)
        #expect(c.epochMs > 1_700_000_000_000)
    }

    @Test func watchdogPadsAStalledStream() async throws {
        let sink = Collect()
        let c = ClockLock(streams: [0, 1], sink: sink)
        c.push(stream: 1, samples: [Float](repeating: 0.1, count: 16), hostTime: c.startHost)
        c.startWatchdog()
        try await Task.sleep(for: .milliseconds(650))
        let now = c.nowMs
        c.flush()
        for s: UInt8 in [0, 1] {
            let ms = Double(sink.samples(s).count) / 16
            // padded up to about now − 100 ms (the timer ticks every 100 ms; allow for a slow machine)
            #expect(ms > 250 && ms <= now - 99, "stream \(s): \(ms) ms of \(now)")
        }
        #expect(sink.samples(0).allSatisfy { $0 == 0 })
    }

    @Test func noWatchdogPaddingWithinThreeHundredMs() async throws {
        let sink = Collect()
        let c = ClockLock(streams: [0], sink: sink)
        c.startWatchdog()
        try await Task.sleep(for: .milliseconds(150))
        c.flush()
        #expect(sink.samples(0).isEmpty)
    }
}

@Suite struct ConverterTests {
    @Test func resamples48kTo16k() {
        let conv = MonoConverter(sourceRate: 48_000)!
        var total = 0
        for i in 0..<10 {
            let out = conv.convert(buffer(rate: 48_000, n: 4800, values: [0.3]))
            if i == 0 { #expect(out.count < 1600) } // AVAudioConverter holds about 240 samples of latency
            total += out.count
        }
        #expect(abs(total - 16_000) <= 300)
    }

    @Test func takesChannelZeroOfAnInterleavedBuffer() {
        let conv = MonoConverter(sourceRate: 16_000)!
        var out: [Float] = []
        for _ in 0..<4 { out += conv.convert(buffer(rate: 16_000, n: 1600, values: [0.5, -0.5], interleaved: true)) }
        #expect(!out.isEmpty)
        #expect(out.suffix(100).allSatisfy { $0 > 0.4 })
    }

    @Test func takesChannelZeroOfAPlanarBuffer() {
        let conv = MonoConverter(sourceRate: 16_000)!
        var out: [Float] = []
        for _ in 0..<4 { out += conv.convert(buffer(rate: 16_000, n: 1600, values: [0.5, -0.9])) }
        #expect(out.suffix(100).allSatisfy { $0 >= 0 })
    }

    @Test func emptyBufferGivesNothing() {
        let conv = MonoConverter(sourceRate: 48_000)!
        #expect(conv.convert(buffer(rate: 48_000, n: 0, values: [0.3])).isEmpty)
    }

    @Test func adaptiveConverterRebuildsOnARateChange() {
        let a = AdaptiveConverter()
        var at48 = 0, at24 = 0
        for _ in 0..<10 { at48 += a.convert(buffer(rate: 48_000, n: 4800, values: [0.3])).count }
        for _ in 0..<10 { at24 += a.convert(buffer(rate: 24_000, n: 2400, values: [0.3])).count }
        // both are 1 s of audio: resampled from the right rate, each is about 16 000 samples
        #expect(abs(at48 - 16_000) <= 300)
        #expect(abs(at24 - 16_000) <= 300)
    }
}

@Suite struct CaptureErrorTests {
    @Test func describesItsMessage() {
        #expect(CaptureError.message("no microphone").description == "no microphone")
    }
}
