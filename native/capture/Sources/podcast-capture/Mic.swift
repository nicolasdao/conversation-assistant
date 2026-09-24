import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

/// The host stream: one explicitly chosen input device through AVAudioEngine. Voice processing stays off.
final class Mic {
    private let engine = AVAudioEngine()
    private var converter: MonoConverter?
    let device: Devices.Input

    init(device: Devices.Input) {
        self.device = device
    }

    func start(clock: ClockLock, stream: UInt8) throws {
        let input = engine.inputNode
        guard let unit = input.audioUnit else { throw CaptureError.message("the input node has no audio unit") }
        var dev = device.id
        let st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        guard st == noErr else { throw CaptureError.message("could not select \(device.name) (OSStatus \(st))") }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, let conv = MonoConverter(sourceRate: format.sampleRate) else {
            throw CaptureError.message("the microphone reports no usable format")
        }
        converter = conv
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, time in
            let host = time.isHostTimeValid ? time.hostTime : mach_absolute_time()
            let samples = conv.convert(buffer)
            if !samples.isEmpty { clock.push(stream: stream, samples: samples, hostTime: host) }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
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
