/*
 * Analog Way Midra — Pulse², Eikos², Saphyr, SmartMatriX², QuickMatriX,
 * QuickVu: the range before Midra 4K (which is the `midra` driver, on AWJ) —
 * on Analog Way's mnemonic protocol, TCP 10500. The protocol and its traps
 * are openRCS's findings on a real Pulse²; driver.js says which.
 *
 * Its rig is the LiveCore driver's sim.mjs, which plays a Pulse² too.
 */

import { MidraClassicDriver, PORT } from './driver.js';

export default {
  api: 1,
  kind: 'switcher',
  id: 'midra-classic',
  label: 'Analog Way Midra (Pulse², Eikos², QuickVu…)',
  description: 'The Midra range before Midra 4K, on Analog Way’s mnemonic protocol, TCP 10500. An input is on air when it is the source of a live layer in a screen’s program.',
  help: 'An input counts as on air while it is a source of a live layer (not the frame layer) in a screen’s program — and from the moment a take starts. AUTO runs the Midra’s own take, with each layer’s own transition time; CUT moves the T-bar. automitti turns preset-update mode off before a take, since a take does nothing while it is on and RCS2 turns it on. A Midra refuses an input with no signal, and the select then says so. The frame has no input names, so give them below. A Pulse² takes one control session, so close RCS2 or openRCS first. Not yet run against a real Midra — only openRCS’s findings on a Pulse², and a simulator.',
  inputCount: 10,
  settings: [
    { key: 'host', label: 'Address', type: 'text', placeholder: '192.168.2.140', required: true },
    { key: 'port', label: 'Port', type: 'number', default: PORT, min: 1, max: 65535 },
    { key: 'screens', label: 'Screens (e.g. 1,2 — empty = all)', type: 'list' },
    { key: 'layer', label: 'Live layer for preview/program selects (1 = the first PiP)', type: 'number', default: 1, min: 1, max: 4 },
    { key: 'names', label: 'Input names, in order (empty = the frame’s)', type: 'list', placeholder: 'Mitti, Camera, Laptop…' },
  ],
  create: ({ settings, log }) => new MidraClassicDriver({ ...settings, log }),
  async testRig() {
    const { startAwSim } = await import('../livecore/sim.mjs');
    const sim = await startAwSim({ family: 'midra', port: 0 });
    return { settings: { host: '127.0.0.1', port: sim.port }, sim, close: () => sim.close() };
  },
};
