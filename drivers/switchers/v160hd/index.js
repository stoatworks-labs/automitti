/*
 * Roland V-160HD — LAN control on TCP 8023, tally pushed by the unit.
 * The protocol and every uncertain point: ../../../docs/V160HD.md.
 */

import { V160hdDriver, V160HD_PORT } from './driver.js';

export default {
  api: 1,
  kind: 'switcher',
  id: 'v160hd',
  label: 'Roland V-160HD',
  description: 'LAN control on TCP 8023, with tally pushed by the switcher.',
  help: 'Set a 4-character NETWORK PASSWORD on the unit (MENU → LAN CONTROL). It allows one LAN client, so RCS over LAN cannot run at the same time.',
  inputCount: 52, // HDMI 1–8, SDI 1–8, STILL 1–16, INPUT 1–20
  settings: [
    { key: 'host', label: 'Address', type: 'text', placeholder: '192.168.0.10', required: true },
    { key: 'port', label: 'Port', type: 'number', default: V160HD_PORT, min: 1, max: 65535 },
    { key: 'password', label: 'Network password', type: 'password', help: 'The 4 characters set on the unit.' },
  ],
  create: ({ settings, log }) => new V160hdDriver({ ...settings, log }),
  async testRig() {
    const { startV160hdSim } = await import('./sim.mjs');
    const sim = await startV160hdSim({ port: 0, password: '0000', autoMs: 150 });
    return { settings: { host: '127.0.0.1', port: sim.port, password: '0000' }, close: () => sim.close() };
  },
};
