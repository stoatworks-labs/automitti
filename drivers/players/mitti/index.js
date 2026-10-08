/*
 * Mitti (imimot), over OSC and its HyperDeck emulation. The research behind
 * it: ../../../docs/MITTI.md.
 */

import { MittiPlayer } from './player.js';

export default {
  api: 1,
  kind: 'player',
  id: 'mitti',
  label: 'Mitti',
  description: 'OSC for control and feedback, HyperDeck for the clip list and durations.',
  help: 'In Mitti → Preferences → OSC, set Feedback To to this machine and the feedback port below — on the same Mac, Custom 127.0.0.1 is safest: Mitti stores the address it picks from its Bonjour list as a bare IP, which breaks when the network changes. Turn on HyperDeck control in Mitti for the clip durations the display shows for the next clip.',
  via: [{ value: 'osc', label: 'OSC' }, { value: 'hyperdeck', label: 'HyperDeck' }],
  relay: true,
  integrations: ['atem', 'ndi'],
  settings: [
    { key: 'host', label: 'Mitti address', type: 'text', default: '127.0.0.1', required: true },
    { key: 'oscPort', label: 'Mitti OSC port', type: 'number', default: 51000, min: 1, max: 65535 },
    { key: 'feedbackPort', label: 'Feedback listen port', type: 'number', default: 51010, min: 0, max: 65535, unique: true, help: 'Each Mitti needs its own. 0 picks any free port.' },
    { key: 'hyperdeck', label: 'Read clips over HyperDeck', type: 'bool', default: true },
    { key: 'hyperdeckPort', label: 'HyperDeck port', type: 'number', default: 9993, min: 1, max: 65535 },
    { key: 'advertise', label: 'Announce the feedback port on Bonjour', type: 'bool', default: true },
  ],
  create: ({ settings, destinations, log }) => new MittiPlayer({ settings, destinations, log }),
  async testRig() {
    const { startMittiSim } = await import('./sim.mjs');
    const sim = await startMittiSim({ oscPort: 0, hyperdeckPort: 0 });
    return {
      settings: { host: '127.0.0.1', oscPort: sim.oscPort, feedbackPort: 0, hyperdeck: true, hyperdeckPort: sim.hyperdeckPort, advertise: false },
      /* The sim sends feedback wherever the driver ended up listening. */
      attach: (player) => sim.setFeedback({ host: '127.0.0.1', port: player.osc.listenPort }),
      sim,
      close: () => sim.close(),
    };
  },
};
