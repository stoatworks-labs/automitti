# Signing & notarizing the automitti desktop app (optional)

**Released builds are already signed and notarised.** I build each release on my own
Mac with the repo's [`scripts/release.sh`](../scripts/release.sh), and the Developer ID
key never leaves it, so there's no release workflow and no signing secret in this
repository. A downloaded release opens with a normal double-click.

This page is only relevant **if** you build a copy yourself. Without a signing identity
that copy is **unsigned**, and macOS Gatekeeper asks you to right-click the app →
**Open** the first time. A signed + notarized build that opens with a normal
double-click needs a paid Apple Developer Program membership. Notarization is a
paid-account feature, and there's no free path.

## What you'd need

A **paid Apple Developer Program** membership and a **Developer ID Application**
certificate (the cert type for distributing apps *outside* the App Store), plus an
**app-specific password** for your Apple ID, made at
[appleid.apple.com](https://appleid.apple.com) → Sign-In & Security → App-Specific
Passwords. **Not** your real Apple ID password. Find your identity's full name with
`security find-identity -v -p codesigning`.

## How a release builds

[`scripts/release.sh`](../scripts/release.sh) at the repo root:

1. stages the universal app (`NODE_PLATFORM=darwin-universal scripts/prepare.sh`),
2. **pre-signs the embedded Node binary and koffi's addons** (`scripts/sign-embedded.sh`)
   with the hardened runtime + [`entitlements.plist`](src-tauri/entitlements.plist):
   nested Mach-Os that must be signed for the bundle to notarize,
3. runs `tauri build --target universal-apple-darwin`, which signs the `.app`,
4. notarises and staples the `.app`, puts it in a `.dmg`, and notarises and staples
   that too, as `dist/release/automitti-<version>-macos-universal.dmg`.

The `.dmg` then goes up to the GitHub release with `gh release create`.

## Building a signed `.dmg` locally

On your Mac with the certificate in your keychain:

```bash
cd launcher
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
npm ci
bash scripts/prepare.sh
bash scripts/sign-embedded.sh
npm run tauri build
```

The signed, notarized `.dmg` lands in
`src-tauri/target/release/bundle/dmg/`.
