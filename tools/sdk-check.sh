#!/usr/bin/env bash
# Check the emulated ATEM with Blackmagic's own Switcher SDK — the same code
# Mitti's ATEM integration runs. Needs "Blackmagic ATEM Switchers" installed
# (it provides the SDK bundle and the Developer SDK headers).
#
#   tools/sdk-check.sh [address]        default 127.0.0.1
#
# 1. The SDK's DeviceInfo sample: connects, validates the state dump, lists inputs.
# 2. tools/sdk/tallytest: per-input tally callbacks, then SetPreviewInput(3) +
#    PerformCut and SetPreviewInput(4) + PerformAutoTransition — exactly what
#    Mitti's "cut/auto to input" does. These TAKES REACH THE REAL SWITCHER behind
#    automitti: only run it against a simulator or a switcher you may cut.
set -euo pipefail
ADDR="${1:-127.0.0.1}"
SDK="/Applications/Blackmagic ATEM Switchers/Developer SDK/Mac OS X"
[ -d "$SDK" ] || { echo "ATEM Switchers Developer SDK not found at $SDK" >&2; exit 1; }
OUT="${TMPDIR:-/tmp}/automitti-sdk"
mkdir -p "$OUT"

echo "== DeviceInfo $ADDR"
"$SDK/Samples/bin/DeviceInfo" "$ADDR" | sed -n '1,14p'

if [ "${2:-}" != "--takes" ]; then
  echo "(add --takes to also run the tally + cut/auto check, which switches the real switcher)"
  exit 0
fi
echo "== tallytest $ADDR"
clang++ -std=c++17 -O1 -o "$OUT/tallytest" "$(dirname "$0")/sdk/tallytest.cpp" \
  "$SDK/include/BMDSwitcherAPIDispatch.cpp" -I"$SDK/include" -framework CoreFoundation
"$OUT/tallytest" "$ADDR" 1
