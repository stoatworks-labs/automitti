/*
 * Analog Way LiveCore — Ascender 16/32/48, NeXtage 08/16, SmartMatriX Ultra —
 * on Analog Way's mnemonic protocol, TCP 10500. The protocol and its traps
 * are openRCS's findings on a real NeXtage 16; driver.js says which.
 *
 * Its rig is sim.mjs, which also plays a Midra for the midra-classic driver.
 */

import { LiveCoreDriver, PORT } from './driver.js';

export default {
  api: 1,
  kind: 'switcher',
  id: 'livecore',
  label: 'Analog Way LiveCore (Ascender, NeXtage, SmartMatriX Ultra)',
  description: 'Analog Way’s mnemonic protocol on TCP 10500. An input is on air when it is the source of a layer in the bank a screen is showing.',
  help: 'An input counts as on air while it is a source of one of a screen’s layers in the bank it is showing — and from the moment a take starts. A take sweeps the T-bar over the take time (the LiveCore’s own take buttons stall over the protocol), and a cut jumps it. Preview and program selects write the chosen layer, then apply it (GROUP_UPDATE). automitti keeps the frame in preset-update mode, as the Web RCS does. Input names are the frame’s own labels. Not yet run against a real LiveCore — only openRCS’s findings on a NeXtage 16, and a simulator.',
  inputCount: 24,
  settings: [
    { key: 'host', label: 'Address', type: 'text', placeholder: '192.168.2.140', required: true },
    { key: 'port', label: 'Port', type: 'number', default: PORT, min: 1, max: 65535 },
    { key: 'screens', label: 'Screens (e.g. 1,2 — empty = all)', type: 'list' },
    { key: 'layer', label: 'Layer for preview/program selects', type: 'number', default: 1, min: 1, max: 24 },
    { key: 'takeMs', label: 'Take time (ms, 0 = cut)', type: 'number', default: 1000, min: 0, max: 10000 },
  ],
  create: ({ settings, log }) => new LiveCoreDriver({ ...settings, log }),
  async testRig() {
    const { startAwSim } = await import('./sim.mjs');
    const sim = await startAwSim({ family: 'livecore', port: 0 });
    return { settings: { host: '127.0.0.1', port: sim.port, takeMs: 200 }, sim, close: () => sim.close() };
  },
};
