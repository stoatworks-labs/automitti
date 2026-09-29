# automitti — desktop app

A small menu-bar app for automitti: pick a network interface and port, start and stop the
server, and open it in a browser. It lives in the system tray.

> **Self-contained.** The bundle embeds a Node runtime and the app itself, so nothing needs
> to be installed on the machine except, for NDI tally, the NDI runtime (NDI Tools).

The shell is a stock copy of
[av-launcher](https://github.com/stoatworks-labs/av-launcher) at `804555c` (`src/`,
`src-tauri/src/`, `src-tauri/crates/`, `Cargo.lock`), taken from LivePremier Plus's
launcher. The app-specific files are `launcher.toml`, `tauri.conf.json`,
`tauri.windows.conf.json`, `Info.plist`, `entitlements.plist`, the icons and
`scripts/prepare.sh`.

## Building

```
./scripts/prepare.sh      # stage server/ + web/ + runtime deps, fetch a Node runtime
npm install
npm run tauri build
```

`NODE_PLATFORM=darwin-universal ./scripts/prepare.sh` stages both macOS architectures:
two Node runtimes merged with `lipo`, and both of koffi's darwin addons.

Signing and notarization are optional. See [SIGNING.md](SIGNING.md).
