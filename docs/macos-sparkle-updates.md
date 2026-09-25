# macOS Automatic Updates with Sparkle

The independently distributed pobox.watch macOS app uses Sparkle 2.10. The iOS
app continues to update through the App Store and must not include Sparkle.

## One-time setup

1. Open `apple/PoboxWatch.xcodeproj` and allow Xcode to resolve Sparkle.
2. Install the Apple **Developer ID Application** certificate in the login
   keychain. Apple Development certificates are not sufficient for distribution.
3. Set the development team for the macOS app and macOS shared framework targets.
4. The app-specific Sparkle key uses the Keychain account `pobox.watch`. Its
   public key is stored in the app's Info.plist; its private key exists only in
   the release Mac's login keychain.
5. Back up that private key securely using Sparkle's documented export option.
   Never store or upload the private key to GitHub or the VPS.

The appcast URL is `https://pobox.watch/updates/macos/appcast.xml`. Automatic
checks are enabled by default and run on Sparkle's normal schedule. Updates are
not installed silently; users retain control over installation.

## Publishing an update

1. Increment `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`. The build number
   must always increase because Sparkle compares `CFBundleVersion`.
2. Archive the macOS target in Release configuration.
3. Sign the app with **Developer ID Application**, notarize it, staple the
   notarization ticket, and verify it with `codesign`, `spctl`, and `stapler`.
4. Place the notarized `.zip` in a local updates directory on the release Mac.
5. Run `scripts/generate-macos-appcast.sh /path/to/updates-directory`. This uses
   Sparkle's `generate_appcast` against that directory and signs the
   archive with the private EdDSA key stored under the `pobox.watch` account in
   the keychain. Approve the login-keychain access prompt on the first run.
6. Publish the archive, generated appcast, and release notes beneath
   `web/public/updates/macos/`, then deploy the web app.
7. From the previously released app, choose **Check for Updates…** and complete
   an actual update before announcing the release.

Do not generate or sign appcasts on the VPS. A server compromise must not expose
the private update-signing key. App Store builds should use App Store updates,
not this feed.

## Verification

Before release, verify all of the following:

```bash
codesign --verify --deep --strict --verbose=2 /path/to/pobox.watch.app
spctl --assess --type execute --verbose=4 /path/to/pobox.watch.app
xcrun stapler validate /path/to/pobox.watch.app
curl -fsS https://pobox.watch/updates/macos/appcast.xml
```

The first published test requires two builds: install the older signed build,
then publish a newer build with a larger `CURRENT_PROJECT_VERSION`. A successful
compile or a valid XML feed does not prove that replacement, relaunch, and
signature validation work end to end.

Back up the private key to encrypted offline storage from the release Mac:

```bash
/path/to/Sparkle/bin/generate_keys --account pobox.watch -x /secure/offline/path/pobox-watch-sparkle-key
```
