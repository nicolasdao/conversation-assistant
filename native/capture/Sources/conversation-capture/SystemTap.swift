import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

/// The remote stream: a private global Core Audio tap of everything the Mac plays, read through a private aggregate
/// device whose main sub-device is the current default output device (Apple's "Capturing system audio with Core Audio
/// taps" sample and AudioCap). The aggregate is rebuilt when the default output device changes.
@available(macOS 14.2, *)
final class SystemTap {
    private let queue = DispatchQueue(label: "conversation-capture.tap", qos: .userInteractive)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var tapUID = ""
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let converter = AdaptiveConverter()
    private var listener: AudioObjectPropertyListenerBlock?
    /// Watches the current output device's sample rate: a Bluetooth headset entering its call profile changes it.
    private var rateListener: AudioObjectPropertyListenerBlock?
    private var watchedOutput = AudioObjectID(kAudioObjectUnknown)
    private var watchedRate: Double = 0
    /// Watches the output's data source: on older Macs, plugging headphones in switches it rather than the device.
    private var sourceListener: AudioObjectPropertyListenerBlock?
    private(set) var sampleRate: Double = 0
    private weak var clock: ClockLock?
    private var stream: UInt8 = 1
    private let status: ([String: Any]) -> Void
    private(set) var outputName = ""
    /// `speakers`, `headphones`, or `virtual` (Devices.outputKind): the engine mutes the microphone while speakers play the call.
    private(set) var outputKind = "speakers"

    init(status: @escaping ([String: Any]) -> Void) {
        self.status = status
    }

    func start(clock: ClockLock, stream: UInt8) throws {
        self.clock = clock
        self.stream = stream
        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        desc.name = "conversation-capture"
        var id = AudioObjectID(kAudioObjectUnknown)
        let st = AudioHardwareCreateProcessTap(desc, &id)
        guard st == noErr, id != kAudioObjectUnknown else { throw CaptureError.message("AudioHardwareCreateProcessTap failed (OSStatus \(st))") }
        tapID = id
        tapUID = desc.uuid.uuidString
        try buildAggregate()
        listenForOutputChanges()
    }

    private func buildAggregate() throws {
        guard let out = Devices.defaultOutput(), let outUID = Devices.uid(out) else { throw CaptureError.message("no default output device") }
        outputName = Devices.name(out)
        outputKind = Devices.outputKind(out)
        let dict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "conversation-capture tap",
            kAudioAggregateDeviceUIDKey: "com.cloudlesslabs.conversation-capture.\(UUID().uuidString)",
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

        // The tap's buffers arrive at the aggregate's rate, which follows the output device: 48 kHz normally, 16 or 24 kHz
        // for a Bluetooth headset in its call profile. Read both now (never cache them), or the audio comes out sped up.
        var addr = Devices.address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let fst = AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd)
        guard fst == noErr else { throw CaptureError.message("could not read the tap format (OSStatus \(fst))") }
        let aggRate = Devices.nominalRate(agg)
        if aggRate > 0 { asbd.mSampleRate = aggRate }
        guard let fmt = AVAudioFormat(streamDescription: &asbd) else { throw CaptureError.message("unusable tap format") }
        sampleRate = asbd.mSampleRate
        watchRate(of: out)
        let conv = converter
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

    /// Rebuilds the aggregate (and so re-reads the rate) when the output device's sample rate changes.
    private func watchRate(of device: AudioObjectID) {
        if watchedOutput == device, rateListener != nil { return }
        unwatchRate()
        watchedRate = Devices.nominalRate(device)
        var addr = Devices.address(kAudioDevicePropertyNominalSampleRate)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self, self.aggregateID != kAudioObjectUnknown else { return }
            // compare with the output's own last rate: rebuilding the aggregate must not retrigger this
            let rate = Devices.nominalRate(device)
            if rate <= 0 || rate == self.watchedRate { return }
            self.watchedRate = rate
            self.destroyAggregate()
            do {
                try self.buildAggregate()
                self.status(["type": "warning", "message": "system audio now runs at \(Int(self.sampleRate)) Hz (the output device changed mode); capture follows it"])
            } catch {
                self.status(["type": "error", "message": "rebuilding the system tap after a sample-rate change failed: \(error)"])
            }
        }
        rateListener = block
        watchedOutput = device
        AudioObjectAddPropertyListenerBlock(device, &addr, queue, block)

        var srcAddr = Devices.address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput)
        guard AudioObjectHasProperty(device, &srcAddr) else { return }
        let srcBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            let kind = Devices.outputKind(device)
            if kind == self.outputKind { return }
            self.outputKind = kind
            self.status(["type": "device_changed", "remote": ["outputDevice": self.outputName, "outputKind": kind]])
        }
        sourceListener = srcBlock
        AudioObjectAddPropertyListenerBlock(device, &srcAddr, queue, srcBlock)
    }

    private func unwatchRate() {
        if let block = rateListener, watchedOutput != kAudioObjectUnknown {
            var addr = Devices.address(kAudioDevicePropertyNominalSampleRate)
            AudioObjectRemovePropertyListenerBlock(watchedOutput, &addr, queue, block)
        }
        if let block = sourceListener, watchedOutput != kAudioObjectUnknown {
            var addr = Devices.address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput)
            AudioObjectRemovePropertyListenerBlock(watchedOutput, &addr, queue, block)
        }
        sourceListener = nil
        rateListener = nil
        watchedOutput = AudioObjectID(kAudioObjectUnknown)
    }

    private func listenForOutputChanges() {
        var addr = Devices.address(kAudioHardwarePropertyDefaultOutputDevice)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self else { return }
            self.destroyAggregate()
            do {
                try self.buildAggregate()
                self.status(["type": "device_changed", "remote": ["outputDevice": self.outputName, "outputKind": self.outputKind]])
            } catch {
                self.status(["type": "error", "message": "rebuilding the system tap failed: \(error)"])
                // still say where sound now goes, so the engine's speaker mode follows the new device (earbuds: mic open)
                if let out = Devices.defaultOutput() {
                    self.outputName = Devices.name(out)
                    self.outputKind = Devices.outputKind(out)
                    self.status(["type": "device_changed", "remote": ["outputDevice": self.outputName, "outputKind": self.outputKind]])
                }
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
        queue.sync { destroyAggregate(); unwatchRate() }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}
