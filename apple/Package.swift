// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MailboxApple",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "MailboxShared", targets: ["MailboxShared"])
    ],
    targets: [
        .target(name: "MailboxShared", path: "Shared/Sources/MailboxShared"),
        .testTarget(name: "MailboxSharedTests", dependencies: ["MailboxShared"], path: "Tests")
    ]
)
