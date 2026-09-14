# iPhone and Mac Apps

Open `PoboxWatch.xcodeproj` in this folder. It replaces the previous separate
`PoboxWatchiOS.xcodeproj` and `PoboxWatchMacOS.xcodeproj` projects.

## Run in Xcode

1. Choose **pobox.watch iOS** for iPhone, or **pobox.watch macOS** for Mac in the scheme selector next to Run.
2. Choose an iPhone simulator, your connected iPhone, or **My Mac**, respectively.
3. Press Run (Command-R).

For installation on an actual iPhone, choose your Apple development team under
Signing & Capabilities for the iOS app and its shared framework target. Existing
bundle identifiers and automatic signing settings have been preserved. This
consolidation does not configure App Store distribution or notarisation.

The installed app is still named **pobox.watch** on both platforms. The different
scheme names only help you select which app to build. Server deployments do not
update an installed native app; build and install it again after native changes.

## Shared Code

Both apps use the files in `Shared/Sources/PoboxWatchShared`. The navigator shows
these sources once. Two framework targets compile them for their respective
platforms, while preserving the `PoboxWatchShared` module imported by both apps.
The Swift package remains available for shared-library tests.

## Build Checks

From the repository root:

```bash
xcodebuild -project apple/PoboxWatch.xcodeproj -scheme "pobox.watch iOS" -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apple/PoboxWatch.xcodeproj -scheme "pobox.watch macOS" -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
```

These unsigned builds check compilation, resources and framework embedding. They
do not verify physical-device signing, passkey handoff or App Store submission.
