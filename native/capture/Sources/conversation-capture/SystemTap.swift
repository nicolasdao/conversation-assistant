import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

/// The remote stream: a private Core Audio tap of everything the Mac plays, read through a private aggregate device whose
/// main sub-device is the current default output device (Apple's "Capturing system audio with Core Audio taps" sample and
/// AudioCap). The aggregate is rebuilt when the default output device changes.
///
/// By default the tap lists the processes playing sound right now and follows them as they start and stop. A global tap
/// (`--tap global`) captures the same sound, but on macOS 26.2 it made other apps hang when they started a microphone
/// (AudioDeviceStart waiting on coreaudiod), in 28 of 32 attempts; a tap that lists processes froze none in 12.
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
    /// The old global tap instead of one that follows the processes playing sound.
    private let global: Bool
    /// The tap's description, whose process list is updated in place (followed taps only).
    private var tapDesc: CATapDescription?
    /// Watches each audio process's "is playing" flag, and the list of audio processes itself.
    private var processListeners: [(AudioObjectID, AudioObjectPropertyListenerBlock)] = []
    private var processListListener: AudioObjectPropertyListenerBlock?
    /// A process can start playing before its listener is attached: a check every second catches it.
    private var processPoll: DispatchSourceTimer?
    private var tapUpdateFailed = false

    init(status: @escaping ([String: Any]) -> Void, global: Bool = false) {
        self.status = status
        self.global = global
    }

    func start(clock: ClockLock, stream: UInt8) throws {
        self.clock = clock
        self.stream = stream
        let desc = global ? CATapDescription(monoGlobalTapButExcludeProcesses: []) : CATapDescription(monoMixdownOfProcesses: SystemTap.playingProcesses())
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
        if !global {
            tapDesc = desc
            queue.sync { followProcesses() }
        }
    }

    // ---------- the processes the tap follows ----------

    static func processObjects() -> [AudioObjectID] {
        var addr = Devices.address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    /// Every other process playing sound right now, as Core Audio process objects.
    static func playingProcesses() -> [AudioObjectID] {
        let me = getpid()
        return processObjects().filter { id in
            var pidAddr = Devices.address(kAudioProcessPropertyPID)
            var pid: Int32 = 0
            var size = UInt32(MemoryLayout<Int32>.size)
            guard AudioObjectGetPropertyData(id, &pidAddr, 0, nil, &size, &pid) == noErr, pid != me else { return false }
            var outAddr = Devices.address(kAudioProcessPropertyIsRunningOutput)
            var running: UInt32 = 0
            size = UInt32(MemoryLayout<UInt32>.size)
            return AudioObjectGetPropertyData(id, &outAddr, 0, nil, &size, &running) == noErr && running != 0
        }
    }

    /// On the tap queue: follows processes appearing, disappearing, and starting or stopping sound.
    private func followProcesses() {
        var addr = Devices.address(kAudioHardwarePropertyProcessObjectList)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.watchEachProcess()
            self?.updateTapProcesses()
        }
        processListListener = block
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, queue, block)
        watchEachProcess()
        let poll = DispatchSource.makeTimerSource(queue: queue)
        poll.schedule(deadline: .now() + 1, repeating: 1)
        poll.setEventHandler { [weak self] in self?.updateTapProcesses() }
        poll.resume()
        processPoll = poll
        updateTapProcesses() // anything that started between the tap's creation and now
    }

    private func watchEachProcess() {
        unwatchEachProcess()
        processListeners = SystemTap.processObjects().map { id in
            var addr = Devices.address(kAudioProcessPropertyIsRunningOutput)
            let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.updateTapProcesses() }
            AudioObjectAddPropertyListenerBlock(id, &addr, queue, block)
            return (id, block)
        }
    }

    private func unwatchEachProcess() {
        for (id, block) in processListeners {
            var addr = Devices.address(kAudioProcessPropertyIsRunningOutput)
            AudioObjectRemovePropertyListenerBlock(id, &addr, queue, block)
        }
        processListeners = []
    }

    /// Sets the tap's process list to the processes playing now, in place: the aggregate and its IO keep running.
    private func updateTapProcesses() {
        guard let desc = tapDesc, tapID != kAudioObjectUnknown else { return }
        let playing = SystemTap.playingProcesses()
        if Set(playing) == Set(desc.processes) { return }
        let previous = desc.processes
        desc.processes = playing
        var addr = Devices.address(kAudioTapPropertyDescription)
        var value: CATapDescription = desc
        let st = withUnsafeMutablePointer(to: &value) {
            AudioObjectSetPropertyData(tapID, &addr, 0, nil, UInt32(MemoryLayout<CATapDescription>.size), $0)
        }
        if st != noErr {
            desc.processes = previous // retried on the next change or poll
            if !tapUpdateFailed {
                tapUpdateFailed = true
                status(["type": "warning", "message": "could not update which apps the system audio tap follows (OSStatus \(st)); an app that started playing may not be captured"])
            }
        } else {
            tapUpdateFailed = false
        }
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
        queue.sync {
            processPoll?.cancel()
            processPoll = nil
            unwatchEachProcess()
            if let block = processListListener {
                var addr = Devices.address(kAudioHardwarePropertyProcessObjectList)
                AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, queue, block)
                processListListener = nil
            }
            tapDesc = nil
        }
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
