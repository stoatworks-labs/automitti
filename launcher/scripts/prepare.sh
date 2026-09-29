#!/usr/bin/env bash
# Assemble the embedded automitti app for the desktop bundle.
#
# automitti has no build step. Staging it is a copy of server/, web/ and
# package.json, an `npm ci --omit=dev` for its three runtime dependencies (ws,
# bonjour-service, koffi), and koffi's native addon for the target — koffi
# ships it as one optional package per platform (@koromix/koffi-<os>-<arch>),
# so a universal macOS bundle needs both darwin packages side by side.
#
# NDI is NOT bundled: automitti loads the NDI runtime already on the machine
# (NDI Tools) at run time. Shipping libndi would take on NDI's licence terms.
#
# Produces src-tauri/node[.exe] and src-tauri/automitti-app/ (both git-ignored;
# they ship inside the bundle). Run before `npm run tauri build`.
#
# NODE_PLATFORM overrides the target (win-x64 / darwin-arm64 / darwin-x64 /
# darwin-universal / linux-x64 / linux-arm64); defaults to the host.
set -euo pipefail

NODE_VERSION="v22.20.0"

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win" ;;
    *) os="linux" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) arch="x64" ;;
  esac
  echo "${os}-${arch}"
}

PLATFORM="${NODE_PLATFORM:-$(detect_platform)}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"     # launcher/
REPO="$(cd "$HERE/.." && pwd)"               # automitti repo root
TAURI="$HERE/src-tauri"
APP="$TAURI/automitti-app"

echo "==> staging the app (server + web)"
rm -rf "$APP"
mkdir -p "$APP"
cp -R "$REPO/server" "$APP/server"
cp -R "$REPO/web" "$APP/web"
cp "$REPO/package.json" "$REPO/package-lock.json" "$APP/"

echo "==> installing runtime dependencies"
# --ignore-scripts: none of the three needs one, and --omit=optional keeps npm
# from choosing koffi's addon by the HOST platform; the right one is fetched below.
( cd "$APP" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund )

KOFFI_VERSION="$(node -p "require('$APP/node_modules/koffi/package.json').version")"
case "$PLATFORM" in
  darwin-universal) __targets="darwin-arm64 darwin-x64" ;;
  win-x64)          __targets="win32-x64" ;;
  win-arm64)        __targets="win32-arm64" ;;
  *)                __targets="$PLATFORM" ;;
esac
for __t in $__targets; do
  echo "    koffi addon: $__t"
  mkdir -p "$APP/node_modules/@koromix/koffi-$__t"
  ( cd "$APP/node_modules/@koromix/koffi-$__t" \
    && curl -sL "$(npm view "@koromix/koffi-$__t@$KOFFI_VERSION" dist.tarball)" | tar -xz --strip-components=1 )
  ls "$APP/node_modules/@koromix/koffi-$__t"/*/koffi.node >/dev/null
done
rm -rf "$APP/node_modules/.bin"
__dangling="$(find "$APP" -type l ! -exec test -e {} \; -print)"
[ -z "$__dangling" ] || { echo "dangling links in the staged app (Tauri will refuse them):" >&2; echo "$__dangling" >&2; exit 1; }

echo "==> fetching self-contained Node $NODE_VERSION ($PLATFORM)"
# nodejs.org publishes no universal macOS build, so the single universal macOS
# bundle needs both runtimes fetched and merged. The app binary being fat is not
# enough on its own: a universal app around an arm64-only node would launch on
# an Intel Mac and then fail the moment it started its server.
if [[ "$PLATFORM" == darwin-universal ]]; then
  for __a in arm64 x64; do
    TARBALL="node-$NODE_VERSION-darwin-$__a"
    curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.tar.gz" -o "$TAURI/node.tar.gz"
    tar xzf "$TAURI/node.tar.gz" -C "$TAURI"
    cp "$TAURI/$TARBALL/bin/node" "$TAURI/node.$__a"
    rm -rf "$TAURI/$TARBALL" "$TAURI/node.tar.gz"
  done
  lipo -create "$TAURI/node.arm64" "$TAURI/node.x64" -output "$TAURI/node"
  # tauri.conf.json globs its resources, so an intermediate left here would be
  # shipped inside the app alongside the real one.
  rm -f "$TAURI/node.arm64" "$TAURI/node.x64"
  chmod +x "$TAURI/node"
  __archs="$( lipo -archs "$TAURI/node" )"
  echo "    embedded node: $__archs"
  case "$__archs" in
    *arm64*) ;;
    *) echo "embedded node has no arm64 slice: $__archs" >&2; exit 1 ;;
  esac
  case "$__archs" in
    *x86_64*) ;;
    *) echo "embedded node has no x86_64 slice: $__archs" >&2; exit 1 ;;
  esac
  echo "prepared: $TAURI/node (universal) + $APP (server + web)"
elif [[ "$PLATFORM" == win-* ]]; then
  TARBALL="node-$NODE_VERSION-$PLATFORM"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.zip" -o "$TAURI/node.zip"
  ( cd "$TAURI"
    if command -v unzip >/dev/null 2>&1; then unzip -q -o node.zip
    elif command -v 7z >/dev/null 2>&1; then 7z x -y node.zip >/dev/null
    else tar -xf node.zip; fi )
  cp "$TAURI/$TARBALL/node.exe" "$TAURI/node.exe"
  rm -rf "$TAURI/$TARBALL" "$TAURI/node.zip"
  echo "prepared: $TAURI/node.exe + $APP"
else
  TARBALL="node-$NODE_VERSION-$PLATFORM"
  curl -sL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL.tar.gz" -o "$TAURI/node.tar.gz"
  tar xzf "$TAURI/node.tar.gz" -C "$TAURI"
  cp "$TAURI/$TARBALL/bin/node" "$TAURI/node"
  chmod +x "$TAURI/node"
  rm -rf "$TAURI/$TARBALL" "$TAURI/node.tar.gz"
  echo "prepared: $TAURI/node + $APP (server + web)"
fi
