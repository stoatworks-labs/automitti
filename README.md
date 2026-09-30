# automitti (preview)

> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. It has run against a real Mitti
> 2.8.18 and Blackmagic's own Switcher SDK, but the switchers only against simulators — see
> [What has been verified](#what-has-been-verified) before relying on it for a show.
>
> **Preview.** v0.1.0 is a preview release: complete enough to try, not yet proven on a real
> V-160HD or Pulse 4K.

A menu-bar app that puts [Mitti](https://imimot.com/mitti/) on switchers Mitti doesn't
know about, such as a **Roland V-160HD** or an **Analog Way Pulse 4K / Midra 4K**. They
drive Mitti the way an ATEM does. automitti also:

- sends Mitti's OSC feedback to **several destinations at once**, where Mitti has only one;
- serves a **clip display page** with the current and next clip, their TRTs, and the current
  clip's elapsed and remaining time.

![The clip display: current clip, big countdown, elapsed, remaining, TRT, and the next clip with its TRT](docs/hero.png)

*The clip display at `/display`, fed by the bundled Mitti simulator. The countdown goes amber
under 30 s and red under 10 s, and the ON AIR chip is the switcher's tally for Mitti's input.*

```
                        ┌──────────────── automitti ────────────────┐
 V-160HD  ◀─ TCP 8023 ─▶│ switcher driver ─┬─▶ emulated ATEM (UDP 9910) ◀──── Mitti's ATEM integration
 Pulse 4K ◀─ AWJ 10606 ▶│   (tally, takes) ├─▶ NDI tally receiver ─────────▶ Mitti's NDI integration
                        │                  └─▶ rules ── OSC / HyperDeck ──▶ Mitti (direct control)
                        │                                                  │
 Companion, Stream Deck ◀── OSC relay ◀── Mitti OSC feedback (UDP 51010) ◀─┘
 any browser ◀── /display (clip clock), / (control + settings)
                        └────────────────────────────────────────────┘
```

Not affiliated with or endorsed by imimot (Mitti), Roland, Analog Way, Blackmagic Design or
Vizrt (NDI). Their names are used only to say what this works with.

<!-- downloads:start -->

## Download

**[v0.1.0](https://github.com/stoatworks-labs/automitti/releases/tag/v0.1.0)** — prebuilt for macOS. Pick your platform:

<details>
<summary><b>macOS</b> — Universal (Apple Silicon + Intel)</summary>

| Build | Download | Size |
| --- | --- | --- |
| Universal (Apple Silicon + Intel) · .dmg disk image | [`automitti-0.1.0-macos-universal.dmg`](https://github.com/stoatworks-labs/automitti/releases/download/v0.1.0/automitti-0.1.0-macos-universal.dmg) | 83 MB |

</details>

All builds, checksums and release notes: [github.com/stoatworks-labs/automitti/releases](https://github.com/stoatworks-labs/automitti/releases).

macOS builds are signed and notarised by Apple, so they open normally — no Gatekeeper warning and no quarantine step.

<!-- downloads:end -->

## Four ways to put Mitti on the switcher

Pick **one** per show. They are alternatives, and running two at once makes both act on
every take.

| Mode | Mitti is set to | What automitti does |
|---|---|---|
| **ATEM** | Integrations → ATEM → *automitti* | Emulates an ATEM whose inputs are the real switcher's inputs. Program, preview and tally follow the real switcher. When Mitti does "cut/auto to input" (Pause-at-End), the take happens on the real switcher. Every one of Mitti's own ATEM options works unchanged. |
| **NDI** | Integrations → NDI | Joins Mitti's NDI output as a *metadata-only* receiver (no video crosses the network), and reports it on program or preview from the real switcher's tally. |
| **OSC rules** | nothing (OSC on) | automitti runs Mitti's ATEM behaviour from its own side: play on program; on preview, rewind; taken off, pause / rewind / load next; cue ends, CUT / AUTO, optionally *n* seconds early. |
| **HyperDeck rules** | HyperDeck control on | The same rules, sent over Mitti's HyperDeck emulation. |

"On air" includes transitions. On a layer switcher (Pulse 4K) an input is on program while it
is a source of any fitted layer in a screen's program buffer. **During a take both buffers
count**, so a clip rolls as the mix starts, not after it.

![The control page: Mitti, switcher, emulated ATEM, NDI and relay status, the switcher's inputs with tally, and settings](docs/screenshots/control.png)

*The control page, against the Mitti and V-160HD simulators.*

## Switchers

| | Transport | Notes |
|---|---|---|
| **Roland V-160HD** | TCP 8023, network password | Tally is **pushed** by the unit (TALLY AUTO SEND). The unit allows **one** LAN client, so RCS over LAN cannot run at the same time. Firmware ≥ 3.3 uses `CUT;`/`ATO;`; older firmware presses the panel buttons. Labels become input names. Protocol notes: [docs/V160HD.md](docs/V160HD.md). |
| **Analog Way Pulse 4K / Midra 4K** (QuickVu, Pulse, Eikos, QuickMatrix) | AWJ, TCP 10606 | AWJ does not push changes, so the transition state is polled every 50 ms and layer sources every 400 ms. Optional screen filter (S1,S2) and the layer that preview/program selects write to. Take = `xTake`, cut = `xCut`, on every screen in scope. |
| **Manual / HTTP** | none | Tally is set from the page or `POST /api/switcher`. This lets anything that can send HTTP (Companion) feed it. |

## OSC feedback to several destinations

Mitti sends feedback to exactly one address. Set it to automitti (it appears in Mitti's
*Feedback To* list as `automitti-51010` over Bonjour). automitti re-sends **every packet,
byte for byte**, to each destination you list: Companion's Mitti module on 51001, a Stream
Deck, a second machine. Only packets from the configured Mitti are relayed.

## Clip display

`http://<this machine>:8710/display`, full screen on any browser:

- current clip name, big remaining time, elapsed, TRT and a progress bar;
- next clip name and **its** TRT, which Mitti's OSC feedback doesn't carry. automitti reads
  clip durations from Mitti's HyperDeck emulation and remembers each cue's TRT once it has
  been current;
- an on-air / preview chip from the switcher's tally, amber and red countdown thresholds, and
  `?frames` to show frames.

Between feedback packets the clock runs locally, so it counts smoothly.

## Running it

- **Tray app:** download it from Releases, press **Start server**, and open the page.
  Settings are stored in `~/Library/Application Support/automitti/config.json`.
- **From a checkout:** `npm install && npm start`, then open <http://localhost:8710/>.
- **Without Mitti or a switcher:** `npm run sim` is a Mitti (OSC + HyperDeck) and
  `node tools/v160hd-sim.mjs` is a V-160HD.

### Traps worth knowing

- **Mitti connects to the first IPv4 address Bonjour gives it.** On a machine with ZeroTier
  or Tailscale that is often the VPN. Set *Network → Announce on address* to the show
  network's address.
- **Mitti's HyperDeck emulation refuses CRLF.** A command ending in `\r\n` gets `103
  unsupported` (only `device info` gets through), so automitti sends LF. Other HyperDeck
  clients that send CRLF see nothing but errors from Mitti.
- **Mitti sends time left as a negative timecode** (`-00:00:45:00`).
- **ZeroTier owns TCP 9993**, which is the HyperDeck port. On a machine running ZeroTier,
  Mitti's HyperDeck emulation can't start, and the page says the port "answered, but not as a
  HyperDeck". You lose the next clip's TRT until it has once been current; nothing else is
  affected.
- **UDP 9910 is one per machine.** Don't run the ATEM emulation on a machine where something
  else already holds it.
- **NDI is loaded from the machine's own NDI runtime** (NDI Tools); automitti doesn't bundle
  it.

## What has been verified

On 2026-09-29, on the author's Mac:

- **Real Mitti 2.8.18:** OSC ping/pong and feedback; feedback relayed. Mitti **selected and
  connected to the emulated ATEM** by itself (over Bonjour) and reconnected after the server
  restarted, including from the packaged tray app. **An AUTO on the (simulated) V-160HD onto
  Mitti's input rolled Mitti through the emulated ATEM** as the transition began. The clip
  list with durations came over Mitti's HyperDeck emulation, and the display showed the
  current and next TRTs correctly. automitti joined **Mitti's own NDI output** as a tally
  receiver.
- **Blackmagic's Switcher SDK 10.2.1** (the code Mitti's ATEM integration runs): the SDK's
  `DeviceInfo` sample accepts the emulated ATEM. Per-input tally callbacks, `SetPreviewInput`,
  `PerformCut` and `PerformAutoTransition` work end to end through to the switcher behind it
  (`tools/sdk-check.sh --takes`). The protocol research is in [docs/ATEM.md](docs/ATEM.md).
- **NDI tally** from switcher takes, read back by an NDI SDK sender via `NDIlib_send_get_tally`,
  the same call Mitti uses.
- **Midra 4K simulator 3.2.29:** tally through AUTO (on air as the take starts), CUT, and
  preview select.
- **Test suite** (`npm test`): the OSC codec and relay, the V-160HD driver against its
  simulator (login, labels, pushed tally, CUT/AUTO, pre-3.3 firmware, wrong password), the
  rules end to end with both simulators, and the ATEM emulator against `atem-connection`.

**Not yet verified:**
- a real V-160HD. It is written from Roland's documents and the Companion module, and its
  uncertain points are listed in [docs/V160HD.md](docs/V160HD.md);
- a real Pulse 4K for this code. Its paths were read off a live Pulse 4K by LivePremier Plus;
- Mitti's own Pause-at-End CUT/AUTO arriving through the emulated ATEM; the SDK path it
  uses (`PerformCut`/`PerformAutoTransition`) is proven;
- Mitti playing on NDI tally, as opposed to receiving it;
- Windows and Linux builds.

## Layout

```
server/            the Node server the tray app runs
  mitti/           OSC link + relay, feedback model, HyperDeck (from LivePremier Plus)
  switchers/       v160hd.js, midra.js, and the shared model
  atem/            the ATEM protocol server and its bridge to the switcher
  ndi/             NDI tally via the installed runtime (koffi FFI)
  rules.js         Mitti's ATEM behaviour, run over OSC/HyperDeck
web/               control + settings page, clip display
tools/             mitti-sim, v160hd-sim, sdk-check.sh
launcher/          the tray app (the fleet's av-launcher shell, Tauri)
docs/              MITTI.md, ATEM.md, V160HD.md: the protocol research
```
