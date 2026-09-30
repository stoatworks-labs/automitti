# ATEM switcher emulator: the server side of the UDP 9910 protocol, as the BMD SDK sees it

Research date: 2026-09-29. Installed stack on this Mac: **ATEM Switchers 10.2.1**
(`pkgutil --pkg-info com.blackmagic-design.Switchers`), bundle
`/Library/Application Support/Blackmagic Design/Switchers/BMDSwitcherAPI.bundle` (Jan 2026 build),
**Mitti 2.8.18** (build 1441).

> The research artefacts this report cites under `atem-research/` (the prototype server, the SDK
> test clients, the disassembly listings and the cloned reference projects) were working files
> and are not part of this repository. `tools/sdk/tallytest.cpp` and `tools/sdk-check.sh` are the
> parts that were kept.

Labels used below:

- **VERIFIED**: tested here against the installed SDK with a prototype server
  (`atem-research/replay_server.py`), using the SDK's own `DeviceInfo` sample and a small
  SDK client, `atem-research/tallytest.cpp`.
- **DISASM**: read from the arm64 disassembly of the installed `BMDSwitcherAPI` (addresses are
  file offsets in the arm64 slice; full listing in `atem-research/bmdapi.s`).
- **SRC**: taken from third-party source, cited by file and line.
- **UNCERTAIN**: not confirmed.

The main result: **the official SDK 10.2.1 connects to an emulator, and I have a working
28-command synthetic initial-state dump (§3.4). DeviceInfo and an SDK client both accept it. Per-input
tally callbacks, SetPreviewInput, PerformCut and PerformAutoTransition all work end to end.**

---

## 0. Where the evidence comes from

| Source | Location (under `atem-research/`) | Role |
|---|---|---|
| LibAtem.MockTests | `LibAtem.MockTests/` (commit 7c5b272) | **The key prior art.** A mock ATEM *server* that the official BMD SDK (Windows) connects to in xunit tests, by replaying real-device handshake dumps (`LibAtem.MockTests/TestFiles/Handshake/*.data`). |
| LibAtem | `LibAtem/` (dc679b1) | Command layouts and the shared connection class (`LibAtem/Net/AtemConnection.cs`). |
| sofie-atem-connection | `sofie-atem-connection/` (6b91b9e) | The client transport (`src/lib/atemSocketChild.ts`). Real dumps up to **firmware 10.1.1 / protocol 2.32** in `src/__tests__/connection/*.data`. |
| pyAtemSim (jonknoll) | `pyAtemSim/` (6bd8f3f, 2021) | Python server. Its README claims "Supports the Blackmagic ATEM software". Replays a raw TVS HD dump at protocol 2.30. |
| openswitcher / pyatem (Martijn Braam) | `pyatem/` (bbded93) | `pyatem/emulator.py` (the proxy/emulator), `transport.py`, `locate.py` (mDNS), `docs/udptransport.rst`. |
| Dev1an/Atem-Simulator | `Atem-Simulator/` | Swift simulator. Claims ATEM Software Control connects (TVS profile). |
| Installed SDK | `bmdapi.s`, `sdk-10.2.1-atoms.txt` | DISASM of the protocol-version check, the state-validity check and the atom sizes. |
| Mitti | `imtatem.s` | DISASM of `IMTAtemListener.framework`, which handles Bonjour and uses the SDK. |

Tools I built for this (all in `atem-research/`): `replay_server.py` (a server prototype with
handshake, dump replay, ACKs, pings and PGM/PVW/tally state), `gen_min.py` (generates the synthetic
minimal dump), `minimal-sdk10.data` (the working minimal dump), `DeviceInfoDbg` (DeviceInfo
rebuilt from the sample source so lldb can attach), `tallytest`, `disctest`, `atoms.py` (extracts
atom sizes from the SDK), `dumpcmds.py` and `showcmd.py` (dump inspectors).

---

## 1. UDP transport, server side

### 1.1 Header (12 bytes, big-endian)

| Bytes | Field | Notes |
|---|---|---|
| 0–1 | `flags:5 | length:11` | `flags = byte0 >> 3`. `length` = whole datagram including the header (`& 0x07FF`). |
| 2–3 | session id | Client-chosen during the handshake, then `0x8000 | clientId`. |
| 4–5 | ack id | Valid when the ACK flag is set: the last packet id received from the peer (cumulative). |
| 6–7 | retransmit-request "from" id | Valid when flag 0x08 is set. |
| 8–9 | "unknown" / remote seq | Zero in normal traffic. The client's SYN may carry a value; LibAtem's mock echoes it. |
| 10–11 | packet id (local sequence) | Only for reliable packets. 0 on pure ACKs and SYNs. |

Flag bits (the value after `>>3`; byte-0 mask in brackets):

| Bit | Value | [byte0] | Meaning |
|---|---|---|---|
| 0 | 0x01 | 0x08 | **Reliable / AckRequest**: the peer must ACK this packet id. |
| 1 | 0x02 | 0x10 | **SYN / NewSessionId** (handshake). |
| 2 | 0x04 | 0x20 | **Retransmission** of an earlier packet. |
| 3 | 0x08 | 0x40 | **Request retransmit** from the id in bytes 6–7. |
| 4 | 0x10 | 0x80 | **ACK / AckReply** (bytes 4–5 valid). |

SRC: `sofie-atem-connection/src/lib/atemSocketChild.ts:28-34` (flag enum), `:176-181` (header
build), `:248-253` (parse: `length=&0x07ff`, `flags=byte0>>3`, session at 2, packet id at 10),
`:267-271` (retransmit-request id read at offset **6**), `:292-293` (ack id at 4).
`LibAtem/LibAtem/Net/AtemConnection.cs:426-449` (the same layout, sender side).
`pyatem/docs/udptransport.rst:12-52`. pyAtemSim `atem_packet.py:38` masks the length with
`0x007F`, which is a bug; use `0x07FF`.

Packet ids wrap at **15 bits** (0x8000 → 0). SRC: `atemSocketChild.ts:12`,
`AtemConnection.cs:22`. Command payloads per datagram: LibAtem caps at 1400 bytes
(`AtemConstants.cs:5`) and pyatem at 1408/1450 (`emulator.py:76,112`). Real dumps use ~1400.

### 1.2 Command (atom) framing inside the payload

The payload is a concatenation of commands: `u16 length (includes these 8 header bytes) | u16
0 | char[4] fourcc | body`. SRC: `pyatem/docs/udptransport.rst:96-111`. DISASM: every
`BEPAtom*::Initialise` writes a u16 length at +0 and the fourcc at +4 (e.g. `BEPAtomInputProperties::Initialise`
@0xa58e4). The SDK calls these "BEP atoms".

### 1.3 Handshake: VERIFIED against the SDK

1. **Client → server**: `flags=SYN`, len 20, session = a random client value (e.g. `0x61d9`),
   payload `01 00 00 00 00 00 00 00`. (Observed from the SDK. The same bytes appear in
   `atemSocketChild.ts:15-18`.)
2. **Server → client**: `flags=SYN`, len 20, **session echoed** (the client's random id), ack 0,
   bytes 8–9 echoed, packet id 0, payload `02 00 CC CC 00 00 00 00` where `CC CC` is a **u16
   client id**.
   - VERIFIED: the SDK then only accepts traffic whose session is exactly **`0x8000 | CCCC`**. The
     pairs (0x001a → 0x801a) and (0x0123 → 0x8123) connect. A mismatch, for example payload id
     0x1a with session 0x8001, or session 0x001a, makes the SDK ignore the dump. It re-sends its
     handshake ACK roughly 230 times, then fails with "State synchronisation timed-out".
   - SRC: LibAtem mock `DeviceMock/AtemMockServer.cs:139-148` (payload `02 00 00 08 …`) together
     with `DeviceMock/AtemConnectionList.cs:46` (session `0x8008`). pyAtemSim
     `client_manager.py:84,97` (`struct.pack('!2H 4x', 0x0200, client_id)`, session
     `0x8000+client_id`). pyatem `emulator.py:22,132`.
   - Payload byte 0 status codes: `0x02` means OK. SRC `udptransport.rst:72-73` says `0x04`
     means "restart". **UNCERTAIN**: what a real ATEM sends when it is full (reportedly `0x03`).
3. **Client → server**: `flags=ACK`, len 12, **old random session**, ack id 0. (Observed.)
4. **Server → client**: the initial-state dump, as reliable packets (flag 0x01) with **session
   `0x8000|id`** and **packet ids 1, 2, 3 …**, ending with `InCm`. (LibAtem mock starts the dump when
   it receives that ACK: `AtemMockServer.cs:193-196` and `AtemServerConnection.cs:29-41`. My
   prototype does the same.)
5. The SDK ACKs with the new session. ACKs are cumulative: one ACK with id 35 covered all 35 dump
   packets (observed).

Real ATEMs send an extra empty `flags=0x11` packet after the dump, and some clients answer it
with the `0x61` quirk (`pyatem/emulator.py:120-121`, `udptransport.rst:86-89`). **Not needed**:
the SDK connected without it.

### 1.4 ACKs, retransmits, keepalive, timeouts

- **Server ACKs**: ACK every client packet that has flag 0x01. Send `flags=0x10`, len 12,
  session, and `ack = client packet id`. My prototype ACKs immediately. LibAtem batches ACKs (every
  5 ms or every 16 packets: `AtemConnection.cs:260-288`, `AtemConstants.cs:8`). An ACK can also
  ride on an outgoing data packet by setting 0x10 together with the ack id (`AtemConnection.cs:358-366,423-445`).
- **Client keepalive (VERIFIED)**: after connecting, the SDK sends an empty
  **`flags=0x11` (reliable+ACK) packet every ~500 ms**, carrying its own incrementing packet id
  and `ack` = the last server packet id. The server must ACK these.
- **Server pings**: with server pings disabled the SDK stayed connected for 12 s+, because it was
  still receiving the ACKs to its own keepalives (VERIFIED). Sending one anyway is cheap and
  harmless. Use an empty reliable packet (flag 0x01), as `AtemConnectionList.QueuePings` does
  every 100 ms (`AtemConstants.cs:6`) and pyAtemSim does after 1 s idle
  (`client_manager.py:16,209-217`). I used 500 ms.
- **SDK disconnect timeout (VERIFIED)**: once the server went fully silent, the SDK raised
  `bmdSwitcherEventTypeDisconnected` ~3.4–3.9 s later (`disctest.cpp`).
- **Server-side client timeout**: other implementations use LibAtem 1000 ms (`AtemConnection.cs:21`),
  sofie 5000 ms (client, `atemSocketChild.ts:8`) and pyAtemSim 3 s (`client_manager.py:17`).
  Recommendation: drop a client after ~3–5 s without any packet.
- **Retransmit**: resend unACKed reliable packets with flag 0x04 set, byte-identical otherwise.
  Intervals elsewhere: LibAtem 30 ms (`AtemConnection.cs:24,331-337`), sofie 60 ms and 10 retries
  (`atemSocketChild.ts:7,10-11`), pyAtemSim 0.5 s. When the client sends a retransmit request
  (flag 0x08, from-id in bytes 6–7), resend from that id. sofie shows that id may arrive as 0x8000
  meaning 0 (`atemSocketChild.ts:357-358`). **UNCERTAIN** whether the SDK ever sends 0x08. It did
  not in my runs.
- **Duplicate detection** (client → server): re-ACK anything that is already covered by the last
  ACK, and drop out-of-order packets. Model on `AtemConnection.cs:152-170`.
- **Client disconnect (VERIFIED)**: the SDK sends `flags=SYN`, len 20, the current session, payload
  `04 00 00 00 00 00 00 00` when the switcher object is released or the process exits. Treat this
  as a close and drop the client. pyatem's emulator does not reply (`emulator.py:144-145`).
  **UNCERTAIN** what a real ATEM replies.

---

## 2. Protocol version rule (`_ver`): DISASM, then VERIFIED

`_ver` is 4 bytes: **u16 major, u16 minor** (equivalently one BE u32, e.g. `0x0002001E` = 2.30).

In SDK 10.2.1 the check happens when **`_pin`** arrives:
`CBMDSwitcher::HandleAtomCapabilitiesProductInfo` (@0xdf30) calls
`CBMDSwitcher::IsBepCompatible(uint8 model, uint32 version)` (@0xdfb0). On failure it sets
`0xb10`. `CBMDSwitcher::Connect` (@0x6b28) then prints *"Unsupported protocol version from
switcher."* and returns `bmdSwitcherConnectToFailureIncompatibleFirmware` ('cfif'). That is what
Mitti shows as "The software on the switcher is incompatible with this version of the switcher
SDK".

**Rule (DISASM @0xdfe4-0xe048):** `required = map[model] ?? 0x0002001E`. The connection is
compatible **iff the major equals `required.major` (2) and `minor ≥ required.minor`**. There is no
upper bound.

Per-model minimum (a 29-entry `std::map<uint8,uint32>` initialised from the table at file offset
0x4e68a8):

- 2.30 for models 0x01–0x0a, 0x0d–0x11, 0x12–0x17, 0x1a–0x1e and 0x20.
- **2.32 for 0x0b (Constellation) and 0x0c (Constellation 8K).**
- Models not in the map (e.g. 0x21, or any unknown value) fall back to 2.30.

VERIFIED with DeviceInfo:

| `_pin` model | `_ver` | Result |
|---|---|---|
| 0x0d | 2.29 | fail cfif |
| 0x0d | 2.30 | ok |
| 0x0d | 2.255 | ok |
| G2 dump | 2.99 | ok |
| G2 dump | 3.32 | fail cfif |
| 0x0c | 2.30 | fail |
| 0x0c | 2.32 | ok |
| 0x40 (unknown) | 2.30 | ok |

**Firmware ↔ `_ver`** (from real dumps; SRC `sofie…/src/enums/index.ts:38-46`,
`LibAtem/LibAtem/Version.cs:5-22`, and the version fields in the `.data` dumps):

| Firmware | `_ver` |
|---|---|
| 7.2 | 2.22 |
| 7.5.2 | 2.27 |
| 8.0.0 | 2.28 |
| 8.0.1–8.1.0 | 2.29 |
| 8.1.1–9.3 | 2.30 |
| 9.4–9.5 | 2.31 |
| 9.6.x and **10.1.1** | **2.32** |

**Recommendation: send `_ver` 2.32 (`00 02 00 20`)**. It matches current firmware and passes this
SDK for every model. The same bundle serves every interface version (it exports
`GetBMDSwitcherDiscoveryInstance_0000…_0012`). Mitti binds `_0009`
(`IMTAtemListener` cstring), but the version check is shared core code, so the rule above applies to
Mitti exactly as it does to DeviceInfo (which binds `_0012`).

Also DISASM @0x6cdc and VERIFIED: model **0x0f (Mini Pro ISO)** fails with *"Unsupported softare
version"* unless a software-version atom is sent. The other ISO models (0x11, 0x16, 0x17, 0x1b,
0x21) additionally require an ISO-record atom (mask bit 0x8000). **Use a non-ISO model byte**, for
example 0x0d (ATEM Mini).

---

## 3. The initial state dump the SDK requires

### 3.1 How the SDK judges completeness (DISASM, then VERIFIED)

- `InCm` (`HandleAtomInitialStateComplete` @0x13650) sets the "complete" flag. `Connect` polls
  every 20 ms for **~5 s** (`w22=0x139c` decremented by 20 per `usleep(20000)`, @0x6b5c-0x6b74).
  Without `InCm` the result is 'cfst' *"Timed out while synchronizing with switcher"* (VERIFIED,
  ~6 s).
- It then calls `CBMDSwitcher::IsEverythingValid()` (@0x6d64). If that fails the result is 'cfss'
  *"Failed to synchronize with switcher"*. The function checks:
  - **A capability-atom bitmask that must match *exactly*** an expected mask computed from `_top`
    and `_pin`. Sending an optional capability atom that `_top` does not announce also fails.

    | Bit | Atom | Bit | Atom |
    |---|---|---|---|
    | 0x1 | `VidM` | 0x200 | `_AMC` |
    | 0x2 | `DcOt` | 0x400 | `_VMC` |
    | 0x4 | `InCm` | 0x800 | `_DVE` |
    | 0x8 | `_ver` | 0x1000 | `V3sl` |
    | 0x10 | `_pin` | 0x2000 | `_FAC` |
    | 0x20 | `_top` | 0x4000 | `_FEC` |
    | 0x40 | `_MvC` | 0x8000 | ISO-record |
    | 0x80 | `Powr` | 0x10000 | `SwVr` |
    | 0x100 | `_SSC` | | |

    The handler → bit mapping comes from the `orr` immediately after each `ldr [x,#0x97c]`.

    Conditional bits, keyed on `_top` payload bytes:

    | `_top` byte | Atom required when non-zero |
    |---|---|
    | 6 multiviewers | `_MvC` |
    | 9 DVE | `_DVE` |
    | 11 supersource | `_SSC` |
    | 12 classic audio | `_AMC` |
    | 15 Fairlight | `_FAC` + `_FEC` |
    | 16 down-converter | `DcOt` |
    | 21 SDI 3G | `V3sl` |

    The ISO/SwVr bits are keyed on the `_pin` model.
  - Object counts against `_top`:
    - Input count = `_top[1]`: send exactly `_top[1]` `InPr`.
    - Aux count = `_top[3]`.
    - Supersource count = `_top[11]`.
    - Multiviewer count = `_top[6]`.
  - Per-object `IsValid()` for inputs, colour generators, aux, supersources, ME keyers, media
    players, HyperDecks, multiviewers, mix-minus outputs, the audio mixer and its inputs, the
    Fairlight mixer and its inputs, **the media pool, the macro pool and macro control**, and camera
    control if `_top[18]`.
- **Unknown atoms are ignored** (`CBMDSwitcher::HandleUnknownAtom` @0x136c8 is a bare `ret`). A
  **corrupt atom** (a known fourcc with a bad size) sets `0xb11` and stops the connection with
  'cfcd' "Corrupt data" (`HandleCorruptAtom` @0x136d0). So each known atom must be sent at the SDK's
  size (§4).

### 3.2 Real dumps replayed as-is (VERIFIED)

| Dump | Result |
|---|---|
| `sofie…/mini-extreme-iso-g2-v10.1.1.data` (2.32, 1108 cmds, 35 pkts) | **DeviceInfo runs clean.** |
| `LibAtem.MockTests/…/tvshd-v8.2.0.data` | SDK connects, then DeviceInfo **segfaults inside the SDK's input iterator**. |
| `tvs-v8.1.1` | SDK connects, then DeviceInfo segfaults inside the SDK's input iterator. |
| `constellation-2me-hd-v9.6.2` | SDK connects, then DeviceInfo segfaults inside the SDK's input iterator. |

The crash frame for the older dumps is `GenericMapIterator<…>::Next` in `BMDSwitcherAPI`. The
official `DeviceInfo` binary does the same (exit 139, no stdout because it is buffered). Older
dumps are therefore not safe to replay against SDK 10.2.1. **UNCERTAIN** why.

The order real devices use is
`_ver _pin _top _MeC _mpl _MvC … _VMC _MAC … Powr VidM … InPr× … PrgI PrvI TrSS TrPr TrPs … _TlC TlIn TlSr … InCm`
(full per-device order: `python3 dumpcmds.py <file>`).

### 3.3 Other projects

- **LibAtem.MockTests** gets the official SDK connected by replaying real dumps byte-for-byte and
  sending a `Time` after every update (`AtemMockServer.cs:61-67`). It does not synthesise state.
- **pyAtemSim** does the same with a TVS HD 2.30 dump (`raw_commands.py`, `atem_commands.py:362-378`)
  and builds only `PrgI`/`PrvI`/`TlIn`/`TlSr`/`TrPs`/`Time` itself (`atem_commands.py:430-531`).
- **pyatem's emulator** proxies a real device's state (`emulator.py:186-214`).
- I found nobody who had published a *synthetic* dump. §3.4 is new.

### 3.4 Minimal synthetic dump accepted by SDK 10.2.1 (VERIFIED)

The file is `atem-research/minimal-sdk10.data`, generated by `gen_min.py`. It is 28 commands in one
packet. DeviceInfo lists 7 inputs and exits 0. `tallytest` gets correct tally and callbacks.

```
_ver 12  00 02 00 1e                      (2.30; use 00 02 00 20 = 2.32)
_pin 52  "ATEM Emulator" pad→40 | 0d 00 00 00     (model byte at payload[40])
_top 36  01 07 00 00 … (28 bytes; [0]=1 ME, [1]=7 sources, all else 0)
_MeC 12  00 00 00 00                      (ME0, 0 keyers)            [droppable]
_MAC 12  00 00 00 00                      (0 macros)                 [REQUIRED]
_VMC 26  00 01 00 00 | 1a 00 00 00 04 00 00 00 00 00 00 00 00 00   (1 mode: 0x1a=1080p30) [REQUIRED]
Powr 12  01 00 00 00                                                  [REQUIRED]
VidM 12  1a 00 00 00                                                  [REQUIRED]
InPr 44  ×7 (ids 0,1,2,3,4,10010,10011); must equal _top[1]           [REQUIRED]
PrgI 12  00 00 00 01        PrvI 16  00 00 00 02 00 00 00 00          [droppable]
TrSS 16  00 00 01 00 01 00 00 00   TrPr 12 00×4   TrPs 16 00 00 19 00 00 00 00 00   TMxP 12 00 19 00 00  [droppable]
MRPr 12  00 00 ff ff        MRcS 12  00 00 ff ff                      [REQUIRED]
TlSr 32  00 07 | 0000 00 | 0001 01 | 0002 02 | 0003 00 | 0004 00 | 271a 00 | 271b 00 | pad  [droppable, but Mitti's tally needs it]
_mpl 12  01 00 00 00        (1 still, 0 clips; stills=0 FAILS)        [REQUIRED]
LKST 12  00 00 00 50        (pool 0 = stills, unlocked)               [REQUIRED]
MPfe 32  00 00 00 00 00 … (24-byte body: bank 0, index 0, unused)     [REQUIRED]
InCm 12  01 00 00 00                                                  [REQUIRED]
```

How "REQUIRED" and "droppable" were determined: I removed one command at a time from this dump and
reconnected (VERIFIED).

- Required: `_MAC`, `_VMC`, `Powr`, `VidM`, `MRPr`, `MRcS`, and the media-pool trio `_mpl`/`LKST`/`MPfe`.
  - The media pool fails `IsValid` unless `CBMDSwitcherStills` has seen `_mpl` (bit 1), at least
    one `MPfe` with `index < stills` (bit 2) and an `LKST` for pool 0 (bit 4). DISASM
    `CBMDSwitcherStills::IsValid` @0x74498 requires `flags == 7`, plus StillCapture validity if
    `_mpl[2] != 0`.
- Droppable: `_MeC`, `TcLk`, `_TlC`, `TlIn`, `TlSr`, `PrgI`, `PrvI`, `TrSS`, `TrPr`, `TrPs`, `TMxP`.
  **Still send `PrgI`, `PrvI` and `TlSr`**: Mitti's tally and the ME state depend on them.

A greedy minimisation of the full Mini Extreme ISO G2 dump agrees: with the richer `_top`, every
capability atom and per-object atom `_top` implies is needed (`min-g2.txt`).

---

## 4. Byte layouts (payload offsets; the 8-byte atom header is excluded)

"SDK size" is the total atom length from `BEPAtom*::GetCreateSize` (DISASM, list in
`sdk-10.2.1-atoms.txt`). BE-swapped field widths come from `PrepareForNetwork` (DISASM,
heuristic).

### Server → client

| Atom | SDK size | Payload layout | Sources |
|---|---|---|---|
| `_ver` | 12 | u16 major, u16 minor | `VersionCommand.cs`, sofie `versionCommand.ts:13` |
| `_pin` | 52 | char[40] name (NUL-padded), u8 **model** @40, 3 pad | `ProductIdentifierCommand.cs:9-12`, sofie `productIdentifierCommand.ts:13`. DISASM reads the model at struct+0x30. |
| `_top` | 36 | See the table below. | SRC `TopologyV811Command.cs:8-42`, sofie `topologyCommand.ts:11-37`. SDK-side bytes 12/15/16/21 are DISASM (@0xde30-0xde88, @0x6d88-0x6e14). |
| `_MeC` | 12 | u8 ME index, u8 keyer count, 2 pad | `MixEffectBlockConfigCommand.cs` |
| `_mpl` | 12 | u8 stills, u8 clips, u8 (still capture?), pad | `MediaPoolConfigCommand.cs`. Byte 2 is **UNCERTAIN**; the SDK uses it to decide whether StillCapture exists. |
| `_MAC` | 12 | u8 macro count | `MacroPoolConfigCommand.cs` |
| `_MvC` | 20 | (only if `_top[6]`) count/window count/flags. The layout differs between sources. | `MultiviewerConfigV811Command.cs`. **UNCERTAIN**; avoid by setting `_top[6]=0`. |
| `_TlC` | 16 | `00 01 00 00`, u8 input count @4 | `TallyChannelConfigCommand.cs:8-12`. Byte 0–3 meaning **UNCERTAIN**. |
| `_VMC` | var | u16 count, 2 pad, then per mode 14 bytes: u8 mode, 3 pad, u32 multiview-mode mask, u32 down-convert mask, u8 requiresReconfig, pad | sofie `videoMixerConfigCommand.ts:19-27`, cross-checked with the G2 dump |
| `Powr` | 12 | u8 bitmask (bit0 PSU1, bit1 PSU2) | `PowerStatusCommand.cs:8-10` |
| `VidM` | 12 | u8 video mode (LibAtem `VideoMode` enum: 6=1080i50, 0x1a=1080p30 as shown by the SDK) | `VideoModeGetCommand.cs` |
| `InPr` | 44 | See the table below. | `InputPropertiesGetCommand.cs`, sofie `InputPropertiesCommand.ts:46-59`. The SDK swaps u16 at 0/28/30/34. |
| `PrgI` | 12 | u8 ME, pad, u16 source | `ProgramInputGetCommand.cs` |
| `PrvI` | 16 | u8 ME, pad, u16 source, 4 bytes | `PreviewInputGetCommand.cs`. LibAtem fills `00 0a 13 01` and says TODO; real dumps have junk; zeros are accepted (VERIFIED). |
| `TrSS` | 16 | u8 ME, u8 style (0 mix, 1 dip, 2 wipe, 3 DVE, 4 sting), u8 selection bitmask (1 = background), u8 next style, u8 next selection, 3 pad | `TransitionPropertiesGetCommand.cs` |
| `TrPr` | 12 | u8 ME, u8 preview-transition bool | `TransitionPreviewGetCommand.cs` |
| `TrPs` | 16 | u8 ME, u8 inTransition, u8 framesRemaining, pad, u16 handlePosition 0–9999, 2 pad | `TransitionPositionGetCommand.cs`, pyAtemSim `atem_commands.py:312` |
| `TMxP` | 12 | u8 ME, u8 rate (frames) | real dumps |
| `TlIn` | `(N+13)&~3` | u16 N, then N × u8 flags (bit0 program, bit1 preview), pad to 4 | DISASM `BEPAtomTalliedInputs::GetCreateSize` @0xa3dcc, `TallyByInputCommand.cs` |
| `TlSr` | `(3N+13)&~3` | u16 N, then N × {u16 source, u8 flags}, pad to 4 | DISASM @0xb37fc, `TallyBySourceCommand.cs` |
| `InCm` | 12 | `01 00 00 00` | `InitializationCompleteCommand.cs`, every dump |
| `Time` | 16 | u8 h, m, s, frame, pad, u8 dropFrame @5, 2 pad | `TimeCodeCommand.cs:9-22`. Optional; LibAtem sends one after every update. |
| `TcLk` | 12 | u8 locked | `TimecodeLockedCommand.cs` |
| `MRPr` | 12 | u8 running flags, u8 loop, u16 macro index (0xFFFF = none) | real dumps, SDK swaps u16 @2 |
| `MRcS` | 12 | u8 recording, pad, u16 index (0xFFFF) | real dumps |
| `LKST` | 12 | u16 pool (0 = stills, 1.. = clips), u8 locked | DISASM `CBMDSwitcherStills::HandleAtomMediaPoolLockStatus` @0x742c0 (pool must be 0), real dumps |
| `MPfe` | var (≥32) | u8 bank (0 = stills), pad, u16 index, u8 used, 16-byte hash, …, u8 name length + name | real dumps. The SDK requires `index < stills` (@0x73c48). The empty 24-byte body is VERIFIED. |

`_top` payload (28 bytes):

| Byte | Field | Byte | Field |
|---|---|---|---|
| 0 | ME count | 11 | supersources |
| 1 | source count | 12 | classic audio mixer |
| 2 | DSKs | 13 | talkback channels |
| 3 | aux | 15 | Fairlight |
| 4 | mix-minus | 16 | down-converter |
| 5 | media players | 18 | camera control |
| 6 | multiviewers | 21 | SDI 3G |
| 7 | serial ports | 22 | advanced chroma |
| 8 | HyperDecks | 23 | only configurable outputs |
| 9 | DVEs | Other bytes | **UNCERTAIN**; 0 works |
| 10 | stingers | | |

`InPr` payload (36 bytes):

| Offset | Field |
|---|---|
| 0 | u16 id |
| 2 | char[20] long name |
| 22 | char[4] short name |
| 26 | u8 namesDefault |
| 28 | u16 available external ports (bitmask: 1 SDI, 2 HDMI, 4 component, 8 composite, 16 S-Video, 0x100 internal) |
| 30 | u16 current external port type |
| 32 | u8 internal port type (0 external, 1 black, 2 bars, 3 colour, 4 MP fill, 5 MP key, 6 SuperSource, 128 ME output, 129 aux, 130 mask, 131 multiview, 132 audio monitor) |
| 34 | u8 source availability (bit0 aux, bit1 MV, bit2 SS art, bit3 SS box, bit4 key source, …) |
| 35 | u8 ME availability (bit0 ME1 …) |

The SDK swaps a **u16 at 34**. Treat 34–35 as sofie/LibAtem do; this is consistent with the real
dumps.

**Tally (VERIFIED, important for Mitti):** `IBMDSwitcherInput::IsProgramTallied`/`IsPreviewTallied`
and the `ipgt`/`iprt` input callbacks are driven by **`TlSr` only**. When the server sent only `TlIn`,
no callback fired and the SDK's tally stayed at the initial values, while `GetProgramInput` still
followed `PrgI`. **Send `TlSr` (containing every `InPr` id) after every change.** Send `TlIn`
(external inputs only, in id order) as well for other clients.

### Client → server (VERIFIED from the SDK's actual traffic)

| Atom | Size | Bytes observed | Layout |
|---|---|---|---|
| `CPvI` | 12 | `00 00 00 03` | u8 ME, pad, u16 source (`PreviewInputSetCommand.cs`) |
| `CPgI` | 12 | (not triggered) | same layout (`ProgramInputSetCommand.cs`, pyAtemSim `atem_commands.py:151`) |
| `DCut` | 12 | `00 00 00 00` | u8 ME, 3 pad |
| `DAut` | 12 | `00 00 00 00` | u8 ME, 3 pad |

The SDK sent **nothing** on connect beyond the handshake and its keepalives in DeviceInfo,
tallytest or a 12 s idle session. In particular there was no `TiRq` and no lock request.
`TiRq` (`BEPAtomTimecodeRequest`, size 8, no body) exists in the SDK. **UNCERTAIN** whether Mitti
triggers it or others; log and ACK unknown commands.

Server response after each command (what worked): update state, then send **one reliable packet
to every client** containing `PrgI`, `PrvI`, `TlIn` and `TlSr`. Optionally add `Time`, and for an
auto transition a `TrPs` ramp (inTransition=1, handle position ramping). pyAtemSim
`atem_commands.py:449-531` has a ramp example; the SDK accepted an instant swap.

`performCutToInput` and `performAutoToInput` in Mitti (`IMTAtemListener`) map to
`SetPreviewInput(id)` followed by `PerformCut()` or `PerformAutoTransition()` on M/E 1. On the wire
that is **`CPvI` then `DCut`/`DAut`, each in its own reliable packet** (observed).

---

## 5. Bonjour advertisement

Mitti (DISASM of `IMTAtemListener.framework`, `imtatem.s` @0x17bc-0x1950 and the resolve callback
@0xe60-0x1170) behaves as follows:

- It browses **both `_blackmagic._tcp` and `_switcher_ctrl._udp`** in the default domain.
  `Info.plist` `NSBonjourServices` lists both.
- On resolve it parses the TXT record:
  - **requires a non-empty `unique id`**, otherwise the service is ignored;
  - **if `class` is present it must equal `AtemSwitcher`**, otherwise the service is ignored (an
    absent `class` is accepted);
  - device id = `unique id`, product name = TXT `name`, custom name = the service instance name;
  - IP = the **first IPv4** address. The SRV port is not used, because the SDK `ConnectTo(ip)`
    always uses 9910.
- It then calls `IBMDSwitcherDiscovery::ConnectTo(ip)`.

Other consumers:

- ATEM Software Control reads `class` (`AtemSwitcher`), `device name` and `unique id` (strings next
  to `BonjourHelperLookup` in its binary).
- openswitcher (`pyatem/locate.py:29-52`) filters on `class`, uses TXT `name` for `_blackmagic._tcp`
  and the instance name for `_switcher_ctrl._udp`, and shows `release version` when present.

Recommended advertisement, on the emulator host:

- `_switcher_ctrl._udp`, port **9910**, instance name = the display name.
- The same instance on `_blackmagic._tcp`, port 9910. This is for ASC/openswitcher; Mitti already
  gets it from `_switcher_ctrl`.
- TXT keys:
  - `txtvers=1`
  - `name=ATEM Emulator`
  - `device name=ATEM Emulator`
  - `class=AtemSwitcher`
  - `unique id=<32-hex, stable>`
  - `protocol version=2.32` (**UNCERTAIN**)
  - `release version=10.1.1` (**UNCERTAIN**)

Test command:
`dns-sd -R "ATEM Emulator" _switcher_ctrl._udp local 9910 txtvers=1 "name=ATEM Emulator" "class=AtemSwitcher" "unique id=0123456789abcdef0123456789abcdef"`.
In Node, use `bonjour-service` or `@homebridge/ciao` with the same TXT.

I could not capture a real ATEM's TXT record: no ATEM answered mDNS on the LAN today, and
the bench switcher was unreachable. The complete real key set and the exact value formats are
**UNCERTAIN**. The keys above are the ones consumers are proven to read.

---

## 6. Implementation checklist for the Node emulator

1. Bind UDP 9910 (only one process per host can). Track clients by `ip:port`.
2. **SYN with payload[0]=0x01**: allocate an id and reply
   `SYN | len 20 | echo session | ack 0 | 0 | echo bytes 8-9 | pid 0 | 02 00 <id u16> 00 00 00 00`.
   Set the session to `0x8000|id` and reset the sequence numbers.
3. **First ACK from the client**: send the dump as reliable packets (≤1400-byte payloads), pids
   from 1, ending with `InCm`. Use the §3.4 set with `_ver` 2.32 and a non-ISO `_pin` model. The
   `InPr` count must equal `_top[1]`. Keep `_top` minimal so no other capability atoms are owed.
4. **Every client packet with flag 0x01**: ACK it. Parse `CPgI`, `CPvI`, `DCut` and `DAut`, then
   broadcast `PrgI`/`PrvI`/`TlIn`/`TlSr` (plus an optional `TrPs` ramp and `Time`).
5. Retransmit unACKed packets after ~50–200 ms with flag 0x04, and honour 0x08 requests. Wrap
   packet ids at 0x8000.
6. Drop a client on SYN payload 0x04 or after ~3–5 s of silence. Sending a reliable ping every
   0.5 s is optional.
7. Advertise over Bonjour as in §5.
8. Verify with `DeviceInfoDbg 127.0.0.1` or the official `DeviceInfo`. The official binary buffers
   stdout, so a crash hides its output. The SDK writes its reason to **stderr**: "Unsupported
   protocol version…", "Failed to synchronize…" or "Corrupt data…". Then run `tallytest` (the tally
   loop) and `disctest` (disconnect timing).
