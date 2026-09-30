# Controlling Mitti from external surfaces — research

2026-09-24. Sources: imimot.com/help/mitti (External Controls + Integrations + Misc pages),
the installed `/Applications/Mitti.app` **2.8.18 (build 1441)** (binary strings, frameworks,
Info.plist, `com.imimot.Mitti.2` prefs, logs), and the installed Companion module
`imimot-mitti-3.10.0` (the reference OSC client and feedback parser).

**Mitti was not launched and nothing was sent to it.** The local prefs have OSC on, with feedback
going to `192.0.2.37:51001` on the show network (that's Companion). Starting it would announce
HyperDeck/OSC on that network.

---

## 1. Every control surface Mitti exposes

| Path | Transport | Direction | Useful for our app? |
|---|---|---|---|
| **OSC** | UDP **51000** in (fixed port), feedback to **one** configurable IP:port (default 51001) | in + feedback | **Primary.** Full transport, cue navigation, per-cue params, and state feedback |
| **UDP string** | UDP 51000, bare address as ASCII, e.g. `/mitti/play` | in only | Only commands with no argument |
| **OSCQuery** | HTTP on **TCP 51000** (same number); Bonjour `_oscjson._tcp` | read | Discovering the address space: types, ranges, descriptions |
| **HyperDeck emulation** | TCP 9993, Ethernet protocol **v1.11**, `model: Mitti` | in + `notify` | Secondary path with its own feedback channel. No shuttle or jog |
| MIDI notes/CC (learn) | CoreMIDI, port "To Mitti" or any source | in | Only 5 learnable functions: Start/Stop, Next, Previous, Main Fader (+Stop) |
| MMC | CoreMIDI | in | PLAY (DeviceID 1–126 = cue 1–126, 127 = current), STOP, REWIND, LOCATE (ID 127) |
| MSC | CoreMIDI | in | GO [Q_NUMBER], RESUME, STOP, RESET (also ALL_OFF/RESTORE in code) |
| MTC / LTC | CoreMIDI / audio input | in | Follower mode. Chases but doesn't lock; no reverse |
| NMC | Imimot's own, UDP broadcast, Bonjour `_nmc._udp` | in or out | Mitti↔Mitti/Vezér sync. Undocumented; RFC1918 ranges only |
| Art-Net | UDP 6454, **broadcast only**, subnet/universe from 0 | in | Same 4 learnable functions as MIDI; channel value > 0 = trigger |
| ATEM trigger | BMD Switcher SDK (needs ATEM Switchers ≥ 9.1) | in | Plays on program; on deselect: nothing/next/pause/rewind; Pause at End can CUT/AUTO the ATEM (M/E 1 only) |
| NDI trigger | NDI tally | in | Same, driven by NDI program tally |
| Keyboard | macOS key events | in | Only fallback for frame-step (←/→) and select (↑/↓) |
| Presentation clicker | PageUp/PageDown | in | prev/next cue |
| Stream Deck plugin | OSC under the hood | in + feedback | Also expects feedback on localhost:51001 |

Not present: AppleScript (no `NSAppleScriptEnabled`, no sdef), any HTTP control API, TCP OSC.

**In follower mode (MTC/LTC), nearly all MIDI, OSC and DMX playback commands are ignored.**
Main Fader and MMC LOCATE still work.

---

## 2. OSC command set (2.8.18, from the binary)

All addresses start `/mitti/`. Cue-level form: `/mitti/{cue}/{cmd}`, where `{cue}` is a
**Cue ID** (up to 6 chars, uppercase; defaults to playlist index), or `current`, `previous`,
`next`, `all`, `selected`.

### Master-level: transport
| Address | Arg | Meaning |
|---|---|---|
| `play` | — | play (from current position) |
| `resume` | — | resume if not playing |
| `pause` / `stop` | — | pause (Companion labels `stop` as "Pause") |
| `togglePause` | — | |
| `togglePlay` | int 0/1 | TouchOSC-style; **this is what feedback reports** |
| `rewind` | — | rewind current cue |
| `panic` | — | panic mode |
| `goto10` / `goto20` / `goto30` | — | jump to last N s of current cue |
| `playhead` | float 0–1 | set playhead of current cue (normalised) |
| `playheadScrub` | string, signed TC, e.g. `+00:00:01:00`, `-00:00:00:01` | relative scrub (Companion says "Requires 2.8.9") |
| `locate` | string TC or seconds | locate playlist |
| `locateCurrentCue` | string `hh:mm:ss:ff` | locate within current cue |
| `mainFader` | float 0–1 | main fader |
| `autoFade` | — | auto fade main fader |

### Master-level: playlist navigation
| Address | Arg | Meaning |
|---|---|---|
| `jumpToNextCue` / `jumpToPrevCue` | — | jump (keeps play state) |
| `triggerNextCue` / `triggerPrevCue` | — | registered; no description string (likely jump + play) |
| `selectNextCue` / `selectPrevCue` / `selectCurrentCue` | — | move the selection only (the "arm" cursor) |
| `playSelectedCue` / `playSelectedCueForceCut` | — | take the selection |
| `jumpToSelectedCue` | — | |
| `playCueWithCueID[ForceCut]` | string (cue ID) | |
| `playCueAtIndex[ForceCut]` | **int** (1-based) | |
| `playCueWithName[ForceCut]` / `jumpToCueWithName` | string | first match by name |
| `{cue}/play`, `{cue}/jump`, `{cue}/select` | — | cue-level versions |

### Master-level: toggles and misc
`loopOn/loopOff/toggleLoop` (playlist loop), `transitionOnPlayOn/Off`, `toggleTransitionOnPlay`,
`toggleGlobalTransition`, `fullscreenOn/Off`, `toggleFullscreen`, `videoOutputsOn/Off`,
`toggleVideoOutputs` (2.8.0+), `muteAudio/unmuteAudio/toggleAudio`,
`setInFromPlayhead`, `setOutFromPlayhead`/`setOutToPlayhead`, `resendOSCFeedback`,
`ping` → answers `/mitti/pong`.

### Cue-level (`/mitti/{cue}/…`)
- Flags, each with `On`/`Off`/`toggle…`: `audio`, `fadeIn`, `fadeOut`, `loop`,
  `pauseAtBeginning`, `pauseAtEnd`, `transition`, `goto`; plus `setGotoToCueID` (string).
- Values: each has a normalised form and a unit form (`…AsPercent`, `…AsPixels`, `…AsDegrees`,
  `volumeAsDecibels`): `opacity`, `brightness`, `contrast`, `hue`, `saturation`, `vibrance`,
  `scale`, `scaleH`, `scaleV`, `posX`, `posY`, `rotate`, `cropTop/Bottom/Left/Right`,
  `volume` (dB −60…+12), `playbackSpeed` (**percent, 1–1200**).
- Exact float ranges come from OSCQuery at runtime (`addOSCAddress:ofType:inRangeWithMin:max:`).
  Read them from `http://<mitti>:51000/` rather than hard-coding.

### Feedback (sent to the single feedback target)
- Master: `togglePlay` (0/1), `playhead` (float 0–1), `time`, `cueTimeLeft`, `cueTimeElapsed`
  (`hh:mm:ss:ff` strings), `currentCueName`, `currentCueID`, `currentCueTRT`, `previousCueName`,
  `nextCueName`, `selectedCueName`, `selectedCueID`, `toggleVideoOutputs`,
  `inFromPlayheadEnabled`, `outFromPlayheadEnabled`, `pong`.
- Per cue: `/mitti/{n}/cueName` **for every cue**, so a `resendOSCFeedback` enumerates the whole
  playlist. Also `/mitti/{n}/toggle{Audio,FadeIn,…}`, `/mitti/{n}/deleted`, param values.
  Every cue-level feedback is echoed as `/mitti/current/…`.
- Mitti sends only the value-carrying form of a command (e.g. never `/mitti/play`).

---

## 3. HyperDeck emulation (IMTHyperDeck.framework)

Responses: `200 ok`, `202 slot info`, `204 device info` (`protocol version: 1.11`,
`model: Mitti`), `205 clips info`, `208 transport info`, `209 notify`, `210 remote info`,
`211 configuration`, `214 clips count`, `500 connection info`, `502/508` async slot/transport,
`103 unsupported`.
Commands handled: `play` (with speed, loop and single clip), `stop`, `goto` (clip id / timecode),
`clips get`, `clips count`, `slot info` (slot 1 only), `transport info`, `notify`, `remote`,
`device info`. Mitti maps loop to the current item or the playlist.
**Shuttle/jog/reverse are unsupported** ("Mitti cannot play videos backwards").
`HyperDeckState = 1` in prefs, so it's on.

---

## 4. Constraints that shape the app design

1. **One OSC feedback target.** Companion is already on it (192.0.2.37:51001). The app has to
   take the feedback itself and **re-emit it to Companion**, or Companion must be moved behind
   the app. Mitti's "Feedback To" dropdown lists Bonjour `_osc._udp` services. Companion
   advertises `Companion-Mitti-Module:<port>`, so the app should advertise itself the same way.
2. **No reverse playback, and speed is a per-cue property.**
   - Shuttle forward = `current/playbackSpeed` 100→1200%. Restore the cue's original speed when
     the ring returns to centre (read it back from the `current/playbackSpeed` feedback).
   - Shuttle reverse = a timer sending `playheadScrub -…` in steps. It will look stepped, not smooth.
   - Jog / frame step = `playheadScrub ±00:00:00:01`. Test whether a scrub while playing pauses.
   - Speed Editor's wheel modes (JOG/SHTL/SCRL) map onto those three.
3. **Selection vs current** is Mitti's preview/program model. `selectNext/Prev` moves the arm
   cursor, `playSelectedCue` takes it, and `selectedCueName/ID` feedback drives a "next up"
   display. That's the right shape for a surface.
4. **Position** is `playhead` (0–1) × TRT. `cueTimeLeft` is ready-made for countdown LEDs/LCDs.
5. **Liveness:** `ping` every 2 s, expect `pong` within 4 s (Companion's scheme).
6. Cue IDs are ≤ 6 chars, uppercased by Companion; `playCueAtIndex` takes an **int** (the only
   int-typed argument Companion sends).
7. Follower mode swallows transport commands. The app should detect this (commands with no
   feedback change) and grey out transport.

## 5. Surfaces: what exists to build on

- **awj-surface** (`~/Projects/video/awj-surface`) already has `MidiSurface` and the Speed
  Editor HID auth (`core/hid/speed-editor.js`, from `@blackmagic-controller/node`). The Speed
  Editor has never been tried on real hardware. Reuse it.
- **Contour ShuttlePRO v2 / ShuttleXpress**: plain USB HID (VID 0x0B33). Report = shuttle
  ring (signed ±7), jog (8-bit wrapping counter), and a button bitfield. No auth. Contour's
  driver holds it open, so quit it or use `node-hid` non-exclusively.
- **Replay Editor**: not researched. Nothing local covers it; treat it as unknown until one is
  on the bench. BMD may use the same auth family as the Speed Editor.
- **MIDI**: generic mapping layer (notes/CC → OSC), with LED/motor-fader feedback from OSC
  feedback. Mitti's native MIDI learn is too thin (5 functions) to rely on.

## 6. Test harness before any real Mitti

Write a `mitti-sim` for the app to talk to, like `tools/hyperdeck-sim.mjs` in LPP. It should
listen on UDP 51000, serve an OSCQuery JSON on TCP 51000, keep a fake playlist, and emit the
feedback vocabulary above. Only use the real Mitti on an isolated network: its saved prefs push
feedback to the show network.

Open questions to settle on a bench Mitti (isolated network):
- The OSCQuery JSON itself: exact types and ranges, and whether `triggerNextCue` differs from `jumpToNextCue`.
- Whether numeric args sent as OSC strings are accepted (Companion sends most values with type `s`).
- How `playheadScrub` and `playbackSpeed` behave mid-play: latency and smoothness at 10–20 Hz.
- `toggleGlobalTransition` vs `toggleTransitionOnPlay`.
