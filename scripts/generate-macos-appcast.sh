#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/directory-containing-notarized-update-zips" >&2
  exit 64
fi

updates_dir=$(cd "$1" && pwd)
if ! find "$updates_dir" -maxdepth 1 -type f -name '*.zip' -print -quit | grep -q .; then
  echo "No .zip update archive found in $updates_dir" >&2
  exit 66
fi

generate_appcast=${SPARKLE_GENERATE_APPCAST:-}
if [[ -z "$generate_appcast" ]]; then
  generate_appcast=$(find "$HOME/Library/Developer/Xcode/DerivedData" \
    -path '*/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_appcast' \
    -type f -perm -111 -print -quit 2>/dev/null || true)
fi
if [[ -z "$generate_appcast" || ! -x "$generate_appcast" ]]; then
  echo "Sparkle generate_appcast was not found. Resolve packages in Xcode or set SPARKLE_GENERATE_APPCAST." >&2
  exit 69
fi

"$generate_appcast" \
  --account pobox.watch \
  --download-url-prefix https://pobox.watch/updates/macos/ \
  --release-notes-url-prefix https://pobox.watch/updates/macos/ \
  --link https://pobox.watch/ \
  --maximum-versions 3 \
  --maximum-deltas 3 \
  -o "$updates_dir/appcast.xml" \
  "$updates_dir"

xmllint --noout "$updates_dir/appcast.xml"
echo "Generated signed appcast: $updates_dir/appcast.xml"
