import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

/// The remote stream: a private global Core Audio tap of everything the Mac plays, read through a private aggregate
/// device whose main sub-device is the current default output device (Apple's "Capturing system audio with Core Audio
/// taps" sample and AudioCap). The aggregate is rebuilt when the default output device changes.
@available(macOS 14.2, *)
final class SystemTap {
    private let queue = DispatchQueue(label: "podcast-capture.tap", qos: .userInteractive)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var tapUID = ""
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var converter: MonoConverter?
    private var tapFormat: AVAudioFormat?
    private var listener: AudioObjectPropertyListenerBlock?
    private weak var clock: ClockLock?
    private var stream: UInt8 = 1
    private let status: ([String: Any]) -> Void
    private(set) var outputName = ""

    init(status: @escaping ([String: Any]) -> Void) {
        self.status = status
    }

    func start(clock: ClockLock, stream: UInt8) throws {
        self.clock = clock
        self.stream = stream
        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        desc.name = "podcast-capture"
        var id = AudioObjectID(kAudioObjectUnknown)
        let st = AudioHardwareCreateProcessTap(desc, &id)
        guard st == noErr, id != kAudioObjectUnknown else { throw CaptureError.message("AudioHardwareCreateProcessTap failed (OSStatus \(st))") }
        tapID = id
        tapUID = desc.uuid.uuidString

        var addr = Devices.address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let fst = AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd)
        guard fst == noErr, let fmt = AVAudioFormat(streamDescription: &asbd), let conv = MonoConverter(sourceRate: asbd.mSampleRate) else {
            throw CaptureError.message("could not read the tap format (OSStatus \(fst))")
        }
        tapFormat = fmt
        converter = conv
        try buildAggregate()
        listenForOutputChanges()
    }

    private func buildAggregate() throws {
        guard let out = Devices.defaultOutput(), let outUID = Devices.uid(out) else { throw CaptureError.message("no default output device") }
        outputName = Devices.name(out)
        let dict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "podcast-capture tap",
            kAudioAggregateDeviceUIDKey: "com.cloudlesslabs.podcast-capture.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapUID]],
        ]
        var agg = AudioObjectID(kAudioObjectUnknown)
        let st = AudioHardwareCreateAggregateDevice(dict as CFDictionary, &agg)
        guard st == noErr, agg != kAudioObjectUnknown else { throw CaptureError.message("AudioHardwareCreateAggregateDevice failed (OSStatus \(st))") }
        aggregateID = agg

        guard let fmt = tapFormat, let conv = converter else { throw CaptureError.message("tap format missing") }
        let stream = self.stream
        var proc: AudioDeviceIOProcID?
        let pst = AudioDeviceCreateIOProcIDWithBlock(&proc, agg, queue) { [weak self] _, inInputData, inInputTime, _, _ in
            guard let self, let clock = self.clock else { return }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: inInputData, deallocator: nil) else { return }
            let host = inInputTime.pointee.mFlags.contains(.hostTimeValid) ? inInputTime.pointee.mHostTime : mach_absolute_time()
            let samples = conv.convert(buffer)
            if !samples.isEmpty { clock.push(stream: stream, samples: samples, hostTime: host) }
        }
        guard pst == noErr, let p = proc else { throw CaptureError.message("AudioDeviceCreateIOProcIDWithBlock failed (OSStatus \(pst))") }
        procID = p
        let sst = AudioDeviceStart(agg, p)
        guard sst == noErr else { throw CaptureError.message("AudioDeviceStart failed (OSStatus \(sst))") }
    }

    private func destroyAggregate() {
        if aggregateID != kAudioObjectUnknown {
            if let p = procID {
                AudioDeviceStop(aggregateID, p)
                AudioDeviceDestroyIOProcID(aggregateID, p)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
    }

    private func listenForOutputChanges() {
        var addr = Devices.address(kAudioHardwarePropertyDefaultOutputDevice)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            self.destroyAggregate()
            do {
                try self.buildAggregate()
                self.status(["type": "device_changed", "remote": ["outputDevice": self.outputName]])
            } catch {
                self.status(["type": "error", "message": "rebuilding the system tap failed: \(error)"])
            }
        }
        listener = block
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, queue, block)
    }

    func stop() {
        if let block = listener {
            var addr = Devices.address(kAudioHardwarePropertyDefaultOutputDevice)
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, queue, block)
            listener = nil
        }
        queue.sync { destroyAggregate() }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}
