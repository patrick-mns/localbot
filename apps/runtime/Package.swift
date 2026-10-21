// swift-tools-version: 6.2
import PackageDescription

// Local Bot's Linux devices without Docker: Apple's Containerization runs the
// same OCI image (trycua/xfce-cua) in a lightweight VM per device. A separate
// package because it needs macOS 26; the app itself supports older systems.
let package = Package(
    name: "LocalBotRuntime",
    platforms: [.macOS("26.0")],
    dependencies: [
        .package(url: "https://github.com/apple/containerization.git", exact: "0.52.1"),
    ],
    targets: [
        .executableTarget(
            name: "LocalBotRuntime",
            dependencies: [
                .product(name: "Containerization", package: "containerization"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
