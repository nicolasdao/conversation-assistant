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
    private let restartQueue = DispatchQueue(label: "podcast-capture.mic-restart")
    let device: Devices.Input

    init(device: Devices.Input) {
        self.device = device
    }

    func start(clock: ClockLock, stream: UInt8) throws {
        self.clock = clock
        self.stream = stream
        try configure()
        // Another app (a WhatsApp or Riverside call, a Bluetooth headset switching to its call profile) can change the
        // audio configuration; macOS then stops this engine, and it must be set up again or the mic goes silent.
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            // Restart off the notifying thread, once things settle, only if the engine really stopped, and at most
            // 5 times a minute: restarting can itself post this notification.
            self?.restartQueue.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self, !self.stopped, !self.engine.isRunning else { return }
                let now = Date()
                self.restarts = self.restarts.filter { now.timeIntervalSince($0) < 60 } + [now]
                if self.restarts.count > 5 {
                    status(["type": "error", "message": "the microphone keeps stopping after audio configuration changes; not restarting it again"])
                    return
                }
                do {
                    try self.configure()
                    status(["type": "warning", "message": "the audio configuration changed (a call or headset switch); the microphone was restarted"])
                } catch {
                    status(["type": "error", "message": "restarting the microphone after an audio configuration change failed: \(error)"])
                }
            }
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
            guard let clock = self?.clock else { return }
            let host = time.isHostTimeValid ? time.hostTime : mach_absolute_time()
            let samples = conv.convert(buffer)
            if !samples.isEmpty { clock.push(stream: stream, samples: samples, hostTime: host) }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        stopped = true
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
