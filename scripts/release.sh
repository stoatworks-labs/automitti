#!/bin/bash
# Local release: the universal tray app, signed with the embedded Node and
# koffi addons, notarised and stapled, inside a signed and notarised DMG at
# dist/release/automitti-<version>-macos-universal.dmg.
#
# Local by design: the Developer ID key never leaves this Mac. Windows and
# Linux builds are not made yet — they have never been run. Then:
#   gh release create v<version> dist/release/*.dmg --prerelease --notes-file <notes>
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
APP_NAME="automitti.app"

# release-lib.sh is vendored from stoatworks-backend/release — edit it there.
source scripts/release-lib.sh
rl_init "automitti" automitti "$VERSION" com.allansargeant.automitti "$PWD/dist/release"
rl_mac_sign_ready || { echo "no Developer ID configured on this Mac" >&2; exit 1; }

# The tray app's versions follow the app's.
for f in launcher/package.json launcher/src-tauri/tauri.conf.json; do
  grep -q "\"version\": \"$VERSION\"" "$f" || { echo "$f is not at $VERSION" >&2; exit 1; }
done
grep -q "^version = \"$VERSION\"" launcher/src-tauri/Cargo.toml || { echo "launcher Cargo.toml is not at $VERSION" >&2; exit 1; }

rl_step "staging the universal app"
( cd launcher && NODE_PLATFORM=darwin-universal bash scripts/prepare.sh )
( cd launcher && APPLE_SIGNING_IDENTITY="$RL_MAC_SIGN_IDENTITY" bash scripts/sign-embedded.sh )

rl_step "building the tray app"
TARGET="$PWD/dist/target"
( cd launcher && npm ci --no-audit --no-fund >/dev/null \
  && APPLE_SIGNING_IDENTITY="$RL_MAC_SIGN_IDENTITY" CARGO_TARGET_DIR="$TARGET" \
     ./node_modules/.bin/tauri build --target universal-apple-darwin --bundles app )
BUILT="$TARGET/universal-apple-darwin/release/bundle/macos/$APP_NAME"

# Both slices, or an Intel Mac downloads an app it cannot run.
for bin in "$BUILT/Contents/MacOS/"* "$BUILT/Contents/Resources/node"; do
  archs="$(lipo -archs "$bin")"
  [[ "$archs" == *x86_64* && "$archs" == *arm64* ]] || { echo "not universal: $bin ($archs)" >&2; exit 1; }
done

stage="$(mktemp -d)"
ditto "$BUILT" "$stage/$APP_NAME"
rl_mac_notarize "$stage/$APP_NAME"
rl_dmg macos-universal "$stage" --app "$APP_NAME"
DMG="$RL_OUT/automitti-$VERSION-macos-universal.dmg"
rl_mac_notarize "$DMG"
rm -rf "$stage"

spctl -a -vv -t install "$DMG"
rl_summary
