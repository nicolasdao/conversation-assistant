// swift-tools-version:6.0
import Foundation
import PackageDescription

// The Info.plist is embedded in the binary: without it, macOS refuses the Microphone and System Audio Recording permissions.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "podcast-capture",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "podcast-capture",
            path: "Sources/podcast-capture",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AVFoundation"),
            ]
        ),
    ]
)
