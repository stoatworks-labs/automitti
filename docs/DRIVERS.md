# Writing a driver

automitti connects two things: a **switcher**, which knows what is on air, and a **player**,
which plays the clips. Both are drivers. The rest of automitti never talks to a switcher or a
player directly: the emulated ATEM, NDI tally, the rules, the clip display and the settings
page all talk to the driver. So a new driver gets all of that without any change elsewhere.

The contract is checked by code in [`server/core/contract.js`](../server/core/contract.js).
This page is the prose version of it.

## Where drivers live

```
drivers/switchers/<id>/index.js     built in, shipped with the app
drivers/players/<id>/index.js
<data>/drivers/switchers/<id>/index.js     yours: <data> is ~/Library/Application Support/automitti
<data>/drivers/players/<id>/index.js       on a Mac, ~/.automitti elsewhere
```

automitti loads them at start.
- **Same id as a built-in:** yours replaces it, which is how you try a fix before it's released.
- **Won't load, or fails the contract:** it's left out, and the reason is shown under the
  Switcher settings and logged. One broken folder never stops the app.

> A driver is code. It runs inside automitti with automitti's access to your network and disk.
> Only install drivers you trust.

## The descriptor

`index.js` default-exports one object:

```js
export default {
  api: 1,                      // the contract version it was written for
  kind: 'switcher',            // or 'player'
  id: 'my-switcher',           // lower-case letters, digits and dashes; unique within its kind
  label: 'Acme Switcher 9000',
  description: 'One sentence, shown under the picker.',
  help: 'Optional: setup notes shown under its settings.',
  settings: [ /* fields, below */ ],
  create({ settings, log, lib }) { return new MySwitcher(settings, log); },
  testRig: async () => ({ settings, close }),   // optional; see "Testing"

  // switchers only
  inputCount: 16,              // or (settings) => number

  // players only
  via: [{ value: 'osc', label: 'OSC' }],   // links the rules can drive it over
  relay: false,                // true if its feedback can be re-sent to destinations
  integrations: ['atem', 'ndi'],   // which switcher emulations it can follow
};
```

### Settings fields

The settings page draws a driver's fields from this list. The values your `create()` receives
are already normalised against it: defaults filled in, numbers coerced, ranges enforced. So a
driver can trust its settings.

```js
{ key: 'host', label: 'Address', type: 'text', placeholder: '192.168.0.10', required: true }
```

| `type` | What the user gets | What you receive |
|---|---|---|
| `text` | a text box | a trimmed string |
| `password` | a masked box | a string |
| `number` | a number box, `min`/`max` enforced | a number, or `default` when out of range |
| `bool` | a checkbox | `true` / `false` |
| `select` | a menu of `options: [{ value, label }]` | one of the values |
| `list` | a comma-separated box | an array of strings |

A field can also have `default`, `help` (shown on hover) and `required` (the switcher won't be
started without it, and the page says which field is missing). Each driver's settings are kept
separately, so switching to another driver and back loses nothing.

A player's field can be marked `unique: true`: each Mitti (device) using that driver needs its
own value, as with a port it listens on. A new device gets one past the highest its devices
use, or the default for the first, and two devices that share a value are flagged on both of
their cards. Empty and `0` are exempt. Mitti's `feedbackPort` is one.

`create()` is also passed `lib`: the protocol code the built-in drivers use. That's
`lib.osc.encode/decode`, `lib.hyperdeck.DeckLink` with its parser, and `lib.analogway`: Analog
Way's mnemonic protocol on TCP 10500 (`AwLink`, a kept-up session, with `encode`/`decode`), which
the LiveCore and Midra drivers use and a PLS300 driver could too. A driver in the data
folder can't import from the app by path, and this is how it gets the same building blocks.

## A switcher

`create()` returns an `EventEmitter` with:

| Method | Does |
|---|---|
| `connect()` | start the connection and keep it up (reconnect on your own) |
| `close()` | stop for good |
| `cut()`, `auto()` | take; return a Promise |
| `setPreview(id)`, `setProgram(id)` | select a source; return a Promise |
| `capabilities()` | optional: `{ cut, auto, preview, program }` for what it cannot do |

It emits:

- **`'status', status, error?`**: `'connecting'`, `'online'` or `'offline'`.
  - Say `online` only when a select or a take would work. If it's said too early, a command
    silently does nothing; the Midra driver had exactly this bug until the contract test caught
    it.
- **`'state', patch`**: any subset of:
  - `inputs`: `[{ id, name, short }]`. `id` is the switcher's own input number, and it's what the
    emulated ATEM and the settings page use.
  - `program`, `preview`: an input id or `null`.
  - `tally`: `{ [id]: { program, preview } }`.
    - It covers everything on air: on a layer switcher that's several inputs, and during a
      transition, **both** sides.
    - Send it if the device can say it; the host derives it from program and preview only when a
      driver never sends one.
  - `inTransition`: `true` while a take is in flight.
  - `device`: `{ model, version? }`.

`inputCount` is how many inputs the emulated ATEM carries. It's topology to an ATEM client, so
changing it makes clients reconnect. Fix it per driver (or per settings) rather than reading it
from the device.

The smallest complete switcher is [`drivers/switchers/manual`](../drivers/switchers/manual/index.js),
which has no device behind it at all. Read it first.

## A player

A player driver runs **once per device**, several at a time (main and backup Mittis), each
with its own settings. Keep all state on the instance, none at module level.

`create()` also gets `destinations()`: that device's relay list, read live. It returns an
`EventEmitter` with:

| Method | Does |
|---|---|
| `start()` | open its links; a port already in use should be reported through `snapshot().error`, not thrown |
| `stop()` | close them |
| `snapshot()` | the playback state, below; called often, so keep it cheap |
| `act(action, { via })` | one of `play`, `pause`, `rewind`, `next`, `prev`, `stoprewind`, `stopnext` |
| `command(address, args)` | optional: a raw message in its own protocol (`POST /api/player {address, args}`) |
| `bonjour()` | optional: services to announce, `[{ key, name, type, protocol, port, txt? }]` |

It emits `'change'` whenever the snapshot may have changed.

The snapshot is everything the clip display, the rules and the status page read:

```js
{
  online: true, error: null,
  playing: true,
  playhead: 0.42,                 // 0–1 within the current clip
  fps: 25,
  updatedAt: 1790671944970,       // when the player last reported; the display runs its clock on from here
  current: { name: 'Opener', index: 2, trtSec: 12 },
  next:    { name: 'Sponsor reel', index: 3, trtSec: 20 },
  elapsedSec: 5.04, remainingSec: 6.96,
  cues: [{ index: 1, name: 'Walk-in', seconds: 30 }, ...],
  summary: '127.0.0.1 · OSC online · 4 clips',   // one line for the status card
  detail: { ... },                // anything else; detail.relay drives the relay card
}
```

The rules call `act()`:
- `play` when the player's input goes on air;
- `stoprewind`, `stopnext` or `pause` when it comes off;
- `rewind` when it goes to preview.

They take a cut or auto on the switcher when `remainingSec` reaches zero, or the lead time,
while the clip is playing.

### What a QLab driver would need

QLab speaks OSC on UDP 53000, and answers `/reply/...` to the port the command came from. A
player driver for it would:

- **Links:** open one UDP socket; `connect` with the workspace passcode, then send `/updates 1`
  for pushed changes.
- **Actions:** map `play` to `/go`, `pause` to `/pause`, `rewind` to `/reset` (or `/cue/selected/…`),
  `next`/`prev` to `/playhead/next` and `/playhead/previous`.
- **Snapshot:** build it from `/runningCues` and `/cue/playhead/…` (name, `duration`, `actionElapsed`),
  polled or pushed. `current` is the running cue, `next` the playhead cue.
- **Descriptor:** `via: [{ value: 'osc', label: 'OSC' }]`, `integrations: []` (QLab follows neither an
  ATEM nor NDI tally, so the rules drive it), and `relay: false`.

None of that is written yet. It's here so the contract is checked against a second player.

## Testing

`test/contract.test.js` holds every driver it can find to the contract.

If the descriptor has a `testRig`, the test also drives it. `testRig` returns a simulator of the
device:

```js
async testRig() {
  const sim = await startMySim({ port: 0 });
  return { settings: { host: '127.0.0.1', port: sim.port }, close: () => sim.close() };
}
```

- **A switcher:** it must come online, list inputs, land a preview select, and put that input on
  program with a cut.
- **A player:** it must come online, report a current clip, play, and pause. A rig can return
  `attach(instance)` to hook the simulator to the driver once it has started. Mitti's does this,
  to send feedback to wherever the driver is listening.

A rig may return `null` when it can't run here. The Midra's rig is Analog Way's own simulator,
enabled with `AUTOMITTI_MIDRA_SIM=host:port`.

To run the suite against your own drivers, lay them out like `drivers/`, then:

```bash
AUTOMITTI_DRIVERS=~/my-drivers npm test
```

## A skeleton

```js
// <data>/drivers/switchers/acme/index.js
import { EventEmitter } from 'node:events';
import net from 'node:net';

class Acme extends EventEmitter {
  constructor({ host, port }, log) { super(); Object.assign(this, { host, port, log }); }
  connect() {
    this.emit('status', 'connecting');
    this.socket = net.connect(this.port, this.host, () => {
      this.emit('status', 'online');
      this.emit('state', { inputs: [1, 2, 3, 4].map((id) => ({ id, name: `Cam ${id}`, short: `C${id}` })) });
    });
    this.socket.on('data', (buf) => { /* parse; emit('state', { program, preview }) */ });
    this.socket.on('close', () => this.emit('status', 'offline', 'connection closed'));
    this.socket.on('error', () => {});
  }
  close() { this.socket?.destroy(); }
  async cut() { this.socket.write('CUT\n'); }
  async auto() { this.socket.write('AUTO\n'); }
  async setPreview(id) { this.socket.write(`PVW ${id}\n`); }
  async setProgram(id) { this.socket.write(`PGM ${id}\n`); }
}

export default {
  api: 1, kind: 'switcher', id: 'acme', label: 'Acme Switcher 9000',
  description: 'Acme over TCP.', inputCount: 4,
  settings: [
    { key: 'host', label: 'Address', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', default: 9000, min: 1, max: 65535 },
  ],
  create: ({ settings, log }) => new Acme(settings, log),
};
```

Restart automitti and it appears in the Switcher menu, with (added) beside its name.
