// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PoboxWatchApple",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "PoboxWatchShared", targets: ["PoboxWatchShared"])
    ],
    targets: [
        .target(name: "PoboxWatchShared", path: "Shared/Sources/PoboxWatchShared"),
        .testTarget(name: "PoboxWatchSharedTests", dependencies: ["PoboxWatchShared"], path: "Tests")
    ]
)
