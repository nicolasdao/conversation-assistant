// swift-tools-version:6.0
import Foundation
import PackageDescription

// The Info.plist is embedded in the binary, like tattle-capture's: it carries the Speech Recognition usage description.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "tattle-transcribe",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "tattle-transcribe",
            path: "Sources/tattle-transcribe",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
                .linkedFramework("Speech"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
            ]
        ),
    ]
)
