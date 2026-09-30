/*
 * Analog Way Pulse 4K and the Midra 4K family (QuickVu, Pulse, Eikos,
 * QuickMatrix) over AWJ, TCP 10606. See driver.js for the paths and how
 * "on air" is worked out on a layer switcher.
 *
 * Its contract-test rig is Analog Way's own simulator, which cannot be
 * started from a test: run one, then
 *   AUTOMITTI_MIDRA_SIM=127.0.0.1:10610 npm test
 * The test takes and cuts on it — never point it at a real frame.
 */

import { MidraDriver, AWJ_PORT } from './driver.js';

export default {
  api: 1,
  kind: 'switcher',
  id: 'midra',
  label: 'Analog Way Pulse 4K / Midra 4K',
  description: 'AWJ on TCP 10606. An input is on air when it is the source of a layer on a screen’s program.',
  help: 'An input counts as on air while it is a source of any fitted layer in a screen’s program buffer — and from the moment a take starts. Preview and program selects write the chosen layer.',
  inputCount: 16,
  settings: [
    { key: 'host', label: 'Address', type: 'text', placeholder: '192.168.2.140', required: true },
    { key: 'port', label: 'Port', type: 'number', default: AWJ_PORT, min: 1, max: 65535 },
    { key: 'screens', label: 'Screens (e.g. S1,S2 — empty = all)', type: 'list' },
    { key: 'layer', label: 'Layer for preview/program selects', type: 'number', default: 1, min: 1, max: 8 },
  ],
  create: ({ settings, log }) => new MidraDriver({ ...settings, log }),
  async testRig() {
    const at = process.env.AUTOMITTI_MIDRA_SIM;
    if (!at) return null;
    const [host, port] = at.split(':');
    return { settings: { host, port: Number(port) || AWJ_PORT }, close: async () => {} };
  },
};
