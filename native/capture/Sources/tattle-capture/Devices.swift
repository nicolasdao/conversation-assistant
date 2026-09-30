import CoreAudio
import Foundation

/// Core Audio device queries: input devices, the default output device, UIDs, and transport types.
enum Devices {
    struct Input {
        let id: AudioDeviceID
        let uid: String
        let name: String
        let transport: String
        let isDefault: Bool
    }

    static func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func allDevices() -> [AudioDeviceID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    static func systemDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID? {
        var addr = address(selector)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
        return id
    }

    static func defaultInput() -> AudioDeviceID? { systemDevice(kAudioHardwarePropertyDefaultInputDevice) }
    static func defaultOutput() -> AudioDeviceID? { systemDevice(kAudioHardwarePropertyDefaultOutputDevice) }

    static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    static func uid(_ id: AudioDeviceID) -> String? { string(id, kAudioDevicePropertyDeviceUID) }
    static func name(_ id: AudioDeviceID) -> String { string(id, kAudioObjectPropertyName) ?? "Unknown" }

    /// A device's nominal sample rate, or 0 when it cannot be read.
    static func nominalRate(_ id: AudioObjectID) -> Double {
        var rate = Float64(0)
        var addr = address(kAudioDevicePropertyNominalSampleRate)
        var size = UInt32(MemoryLayout<Float64>.size)
        return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &rate) == noErr ? rate : 0
    }

    static func transportType(_ id: AudioDeviceID) -> UInt32 {
        var addr = address(kAudioDevicePropertyTransportType)
        var t: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        _ = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &t)
        return t
    }

    static func transportName(_ t: UInt32) -> String {
        switch t {
        case kAudioDeviceTransportTypeBuiltIn: return "builtin"
        case kAudioDeviceTransportTypeUSB: return "usb"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
        case kAudioDeviceTransportTypeVirtual: return "virtual"
        case kAudioDeviceTransportTypeAggregate: return "aggregate"
        case kAudioDeviceTransportTypeAirPlay: return "airplay"
        case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return "display"
        case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
        case kAudioDeviceTransportTypeContinuityCaptureWired, kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity"
        default: return "unknown"
        }
    }

    /// The output's current data source on a built-in device ('ispk' internal speakers, 'hdpn' headphones), when it has one.
    static func outputDataSource(_ id: AudioDeviceID) -> UInt32? {
        var addr = address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput)
        var src: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectHasProperty(id, &addr), AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &src) == noErr else { return nil }
        return src
    }

    static func fourCC(_ s: String) -> UInt32 { s.utf8.reduce(0) { $0 << 8 | UInt32($1) } }

    /// Where an output device plays: `speakers` (heard in the room, so the microphone hears it too), `headphones`, or
    /// `virtual` (nobody hears it). Bluetooth counts as headphones (AirPods, earbuds). Anything unsure counts as speakers:
    /// muting the microphone needlessly costs less than transcribing the call twice.
    static func outputKind(_ id: AudioDeviceID) -> String {
        switch transportType(id) {
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "headphones"
        case kAudioDeviceTransportTypeVirtual: return "virtual"
        case kAudioDeviceTransportTypeBuiltIn:
            // Apple silicon lists the headphone jack as its own device ("External Headphones"); older Macs switch the
            // built-in output's data source instead.
            if let src = outputDataSource(id) {
                if src == fourCC("hdpn") { return "headphones" }
                if src == fourCC("ispk") { return "speakers" }
            }
            return name(id).localizedCaseInsensitiveContains("headphone") ? "headphones" : "speakers"
        default: return "speakers"
        }
    }

    static func hasInput(_ id: AudioDeviceID) -> Bool {
        var addr = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr else { return false }
        return size > 0
    }

    static func inputs() -> [Input] {
        let def = defaultInput()
        return allDevices().filter(hasInput).compactMap { id in
            guard let uid = uid(id) else { return nil }
            return Input(id: id, uid: uid, name: name(id), transport: transportName(transportType(id)), isDefault: id == def)
        }
    }

    /// `builtin` is the input device whose transport type is built-in; anything else matches by UID.
    static func resolveMic(_ spec: String) -> Input? {
        let all = inputs()
        if spec == "builtin" { return all.first { $0.transport == "builtin" } }
        return all.first { $0.uid == spec }
    }
}
