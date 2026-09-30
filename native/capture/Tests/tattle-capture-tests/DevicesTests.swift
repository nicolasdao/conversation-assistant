import CoreAudio
import Foundation
import Testing
@testable import tattle_capture

@Suite struct DevicesTests {
    @Test func namesEveryTransport() {
        let cases: [(UInt32, String)] = [
            (kAudioDeviceTransportTypeBuiltIn, "builtin"),
            (kAudioDeviceTransportTypeUSB, "usb"),
            (kAudioDeviceTransportTypeBluetooth, "bluetooth"),
            (kAudioDeviceTransportTypeBluetoothLE, "bluetooth"),
            (kAudioDeviceTransportTypeVirtual, "virtual"),
            (kAudioDeviceTransportTypeAggregate, "aggregate"),
            (kAudioDeviceTransportTypeAirPlay, "airplay"),
            (kAudioDeviceTransportTypeHDMI, "display"),
            (kAudioDeviceTransportTypeDisplayPort, "display"),
            (kAudioDeviceTransportTypeThunderbolt, "thunderbolt"),
            (kAudioDeviceTransportTypeContinuityCaptureWired, "continuity"),
            (kAudioDeviceTransportTypeContinuityCaptureWireless, "continuity"),
            (0, "unknown"),
        ]
        for (t, name) in cases { #expect(Devices.transportName(t) == name, "transport \(t)") }
    }

    @Test func fourCCPacksFourCharacters() {
        #expect(Devices.fourCC("hdpn") == 0x6864_706E)
        #expect(Devices.fourCC("ispk") == 0x6973_706B)
    }

    @Test func addressDefaultsToTheGlobalScopeAndMainElement() {
        let a = Devices.address(kAudioHardwarePropertyDevices)
        #expect(a.mSelector == kAudioHardwarePropertyDevices)
        #expect(a.mScope == kAudioObjectPropertyScopeGlobal)
        #expect(a.mElement == kAudioObjectPropertyElementMain)
        #expect(Devices.address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput).mScope == kAudioObjectPropertyScopeOutput)
    }
}
