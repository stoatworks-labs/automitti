# Attributions

automitti is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Code we derived from other people's work

Someone else solved this first, and this project would not exist in its current form without their work.

### HyperDeck protocol and deck link — Stoatworks livepremier-plus

<https://github.com/stoatworks-labs/livepremier-plus>  
Licence: MIT  
Copyright: Stoatworks Labs

Same fleet, copied rather than shared: server/lib/hyperdeck/protocol.js, the Blackmagic HyperDeck Ethernet Protocol's parser and command builders, is copied unchanged from LivePremier Plus (plugins/hyperdeck/protocol.js, 9703ce3), and link.js is copied from the same commit and changed to wait for the deck's greeting before calling it connected and to end commands with LF, because Mitti refuses CRLF. server/rules.js mirrors LivePremier Plus's HyperDeck rules, and the Pulse 4K / Midra 4K driver's object model was read off a live Pulse 4K on 3.3.10 by LivePremier Plus.

### Analog Way mnemonic protocol and its traps — Stoatworks openrcs

<https://github.com/stoatworks-labs/openrcs>  
Licence: MIT  
Copyright: Stoatworks Labs

Same fleet, written from rather than copied: server/lib/analogway.js, the LiveCore driver (drivers/switchers/livecore/: Ascender, NeXtage, SmartMatriX Ultra), the Midra driver (drivers/switchers/midra-classic/: Pulse², Eikos², QuickVu and the rest of the range before 4K) and the simulator drivers/switchers/livecore/sim.mjs were written from openRCS's docs/PROTOCOL.md, docs/NOTES.md and crates/openrcs-server/web/app.js, with no code copied verbatim. From there come the TCP 10500 framing; the LiveCore's preset banks, with GCsta naming the bank on air, and its take as a sweep of the T-bar, because the device's own take verbs stall a real NeXtage; the Midra take GCtak with preset-update mode (CTpmu) turned off first, because it is dead while on; the Midra cut as a GCtba move in two steps, which only lands if the bar is seen to travel; the Midra's silent refusal of an input with no signal, which is why a select is read back; and the PDEV and DEV model maps. openRCS found all of it on a real NeXtage 16 and Pulse²; automitti's drivers have run against the simulator only.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### Tauri

<https://tauri.app>  
Licence: MIT or Apache-2.0  
Copyright: The Tauri Programme within The Commons Conservancy

A Cargo and npm dependency — of the app itself under src-tauri/, or of the desktop launcher under launcher/src-tauri/.

Wraps a web front end in a native desktop app using the platform's own webview rather than a bundled browser, so the binary stays small.

### The Rust crate ecosystem

<https://crates.io>  
Licence: predominantly MIT or Apache-2.0  
Copyright: the individual crate authors

Cargo dependencies, resolved and pinned in Cargo.lock.

Async runtimes, protocol codecs, serialisation and GUI toolkits. The exact set and versions for any build are in that repo's Cargo.lock, which is the authoritative list.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Work we checked ourselves against

No code was taken from these — but they were how we knew we had it right, and that is worth saying out loud.

### Mitti — imimot

<https://imimot.com/mitti/>

The OSC command and feedback vocabulary, the HyperDeck emulation and the map of Mitti's external controls in docs/MITTI.md come from imimot's help pages (External Controls, Integrations, Misc) and from the installed Mitti 2.8.18: binary strings, frameworks, Info.plist, prefs and logs. How Mitti's ATEM integration finds and drives a switcher comes from a disassembly of IMTAtemListener.framework (docs/ATEM.md). Run end to end against a real Mitti 2.8.18, and 2.8.19 on the Midra 4K simulator. Not affiliated with or endorsed by imimot.

### Bitfocus Companion module imimot-mitti 3.10.0

Read as the reference OSC client and feedback parser for docs/MITTI.md. automitti's liveness check is Companion's scheme: /mitti/ping every 2 s, online while a /mitti/pong has come back within the last 4 s.

### Blackmagic ATEM Switchers SDK 10.2.1 — Blackmagic Design

Mitti's ATEM integration is this SDK, so the emulated ATEM in server/atem/ was established against it: the SDK's own DeviceInfo sample and a small SDK client (tools/sdk/tallytest.cpp, run by tools/sdk-check.sh) accept it, and per-input tally, SetPreviewInput, PerformCut and PerformAutoTransition work end to end. The protocol-version rule, the completeness check on the initial state dump and the atom sizes were read from a disassembly of the installed BMDSwitcherAPI.bundle; docs/ATEM.md labels every fact VERIFIED, DISASM, SRC or UNCERTAIN.

### LibAtem and LibAtem.MockTests

The key prior art: LibAtem.MockTests is a mock ATEM server the official SDK connects to in tests by replaying real-device handshake dumps (7c5b272), and LibAtem supplies the command layouts and the shared connection class (dc679b1). docs/ATEM.md cites both by file and line for the UDP header, the handshake, ACK batching, retransmit timing and most atom layouts.

### sofie-atem-connection

Its client transport (src/lib/atemSocketChild.ts) and its real device dumps up to firmware 10.1.1 / protocol 2.32 (6b91b9e) are cited by file and line in docs/ATEM.md; its Mini Extreme ISO G2 dump is the one the SDK accepted as-is. As atem-connection, the client Companion uses, it is also the test suite's second client against the emulator.

### pyAtemSim — jonknoll

A Python ATEM server replaying a TVS HD dump at protocol 2.30 (6bd8f3f), cited in docs/ATEM.md for client ids, pings, timeouts and its transition ramp, and for a length-mask bug (0x007F for 0x07FF) the emulator avoids.

### openswitcher / pyatem — Martijn Braam

pyatem's emulator, transport and mDNS locator and its UDP transport documentation (bbded93), cited in docs/ATEM.md for the command framing, the handshake status codes and the Bonjour TXT keys consumers actually read.

### Dev1an/Atem-Simulator

A Swift ATEM simulator, listed in docs/ATEM.md among the sources the emulator's evidence was gathered from.

### Roland V-160HD Remote Control Guide (eng06) — Roland

<https://static.roland.com/assets/media/pdf/V-160HD_Control_eng06_W.pdf>

The V-160HD driver is written from it and the working Companion client: the LAN/RS-232 transport, framing and error codes, the DTH/RQH SysEx address map, source codes, labels and TALLY AUTO SEND. docs/V160HD.md tags every item [DOC], [CLIENT] or [UNCERTAIN]. The driver has not yet run against a real unit, only against sim.mjs, which is built from the same documents.

### Roland LAN/RS-232 Basic Control Commands (eng02) — Roland

<https://static.roland.com/assets/media/pdf/LAN_RS-232_Basic_Control_Commands_eng02_W.pdf>

The plain-text CUT; and ATO; the driver uses from firmware 3.3, and the basic-command replies docs/V160HD.md records.

### Roland V-160HD Reference Manual (eng09) — Roland

<https://static.roland.com/assets/media/pdf/V-160HD_Reference_eng09_W.pdf>

The one-LAN-client limit, the network password and the operation modes the driver's tally reading depends on.

### Bitfocus Companion module for the Roland V-160HD

<https://github.com/bitfocus/companion-module-roland-v160hd>

The working client the driver is written from alongside Roland's guide: the login exchange, the tally push and the panel press-and-release are what it does on real hardware, which Roland does not document. Its issues #19, #21 and #26 are the source of the driver's tally, connection-limit and polling cautions.

### companion-module-roland-v160hd, a production fork

<https://github.com/roopeberg/companion-module-roland-v160hd>

A fork used by a live-events company. Its TESTING.md confirmed multi-byte reads live, and its 52-entry tally table, pushed on every source change, and its re-reading of the buses after each push are what the driver does.

### roland-rs

<https://github.com/FlowingSPDG/roland-rs>

A Rust client cited in docs/V160HD.md for the login exchange, tolerant ACK parsing and the report that the unit often never acknowledges the tally subscription, which is why the driver does not wait for it.

### streamdeck-roland-v160hd

<https://github.com/MikanseiLaboratory/streamdeck-roland-v160hd>

A Stream Deck plugin, cited alongside roland-rs for the unacknowledged tally subscription.

### Analog Way Midra 4K simulator 3.2.29 — Analog Way

The Pulse 4K / Midra 4K driver's AWJ paths (transition state, live-layer sources, the applied configuration, xTake and xCut) were proven against it, and a real Mitti 2.8.19 rolled through the emulated ATEM on a simulated AUTO. The driver has not run against a real Pulse 4K.

## Standards and published specifications

What the implementation is measured against.

- **OSC 1.0** — server/lib/osc.js implements the subset Mitti and Companion use (messages and bundles, argument types i f s b T F N) with no library, so the feedback relay can keep each raw packet and re-send it byte for byte.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
