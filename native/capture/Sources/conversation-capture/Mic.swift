import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

/// The host stream: one explicitly chosen input device through AVAudioEngine. Voice processing stays off.
final class Mic {
    private let engine = AVAudioEngine()
    private let converter = AdaptiveConverter()
    private var observer: NSObjectProtocol?
    private weak var clock: ClockLock?
    private var stream: UInt8 = 0
    private var stopped = false
    private var restarts: [Date] = []
    private let restartQueue = DispatchQueue(label: "conversation-capture.mic-restart")
    /// When the last buffer arrived (mach time), or when the engine was last (re)started. Guarded by `lastLock`.
    private var lastBufferAt: UInt64 = 0
    private let lastLock = NSLock()
    private var watchdog: DispatchSourceTimer?
    private var gaveUpAt: Date?
    let device: Devices.Input

    init(device: Devices.Input) {
        self.device = device
    }

    func start(clock: ClockLock, stream: UInt8) throws {
        self.clock = clock
        self.stream = stream
        try configure()
        // Another app (a WhatsApp or Riverside call, a Bluetooth headset switching to its call profile) can change the
        // audio configuration. macOS then either stops this engine or, worse, leaves it "running" with no buffers
        // arriving (seen on 27 September 2026: a WhatsApp call on Bluetooth earbuds silenced the mic for the rest of the
        // session, with isRunning still true). So the notification only prompts a check; the watchdog decides.
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.restartQueue.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.restartIfStalled(after: 0.4, reason: "the audio configuration changed (a call or headset switch)") }
        }
        // Whatever the cause, a microphone that delivers no buffers for 1.5 s is restarted.
        let w = DispatchSource.makeTimerSource(queue: restartQueue)
        w.schedule(deadline: .now() + 1, repeating: 0.5)
        w.setEventHandler { [weak self] in self?.restartIfStalled(after: 1.5, reason: "the microphone stopped delivering audio") }
        w.resume()
        watchdog = w
    }

    private func markAlive() {
        lastLock.lock()
        lastBufferAt = mach_absolute_time()
        lastLock.unlock()
    }

    private func secondsSinceLastBuffer() -> Double {
        lastLock.lock()
        let last = lastBufferAt
        lastLock.unlock()
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return Double(mach_absolute_time() &- last) * Double(tb.numer) / Double(tb.denom) / 1e9
    }

    /// On restartQueue: restarts the engine when no buffer arrived for `after` seconds, whatever `isRunning` says.
    /// At most 5 restarts a minute (a restart can itself post a configuration change); past that it keeps trying every
    /// 10 s instead of giving up, so the microphone always comes back once the device settles.
    private func restartIfStalled(after: Double, reason: String) {
        guard !stopped else { return }
        if secondsSinceLastBuffer() < after {
            if after >= 1.5 { gaveUpAt = nil } // buffers are flowing again (only the watchdog, the longer check, resets it)
            return
        }
        let now = Date()
        restarts = restarts.filter { now.timeIntervalSince($0) < 60 }
        if restarts.count >= 5 {
            if let g = gaveUpAt, now.timeIntervalSince(g) < 10 { return }
            if gaveUpAt == nil { status(["type": "error", "message": "the microphone keeps stopping; retrying every 10 s until it delivers audio again"]) }
            gaveUpAt = now
        }
        restarts.append(now)
        do {
            try configure()
            status(["type": "warning", "message": "\(reason); the microphone was restarted"])
        } catch {
            status(["type": "error", "message": "restarting the microphone failed (\(reason)): \(error)"])
            markAlive() // wait a full interval before the next try
        }
    }

    /// Selects the device, installs the tap in the input's hardware format, and starts the engine.
    private func configure() throws {
        engine.stop()
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        guard let unit = input.audioUnit else { throw CaptureError.message("the input node has no audio unit") }
        var dev = device.id
        let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard st == noErr else { throw CaptureError.message("could not select \(device.name) (OSStatus \(st))") }
        let format = input.inputFormat(forBus: 0)
        guard format.sampleRate > 0 else { throw CaptureError.message("the microphone reports no usable format") }
        let conv = converter
        let stream = self.stream
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
            guard let self, let clock = self.clock else { return }
            self.markAlive()
            let host = time.isHostTimeValid ? time.hostTime : mach_absolute_time()
            let samples = conv.convert(buffer)
            if !samples.isEmpty { clock.push(stream: stream, samples: samples, hostTime: host) }
        }
        engine.prepare()
        markAlive() // the watchdog counts from this start
        try engine.start()
    }

    func stop() {
        stopped = true
        restartQueue.sync { watchdog?.cancel(); watchdog = nil }
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

enum CaptureError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self {
        case .message(let m): return m
        }
    }
}
