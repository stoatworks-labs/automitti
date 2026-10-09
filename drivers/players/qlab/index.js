/*
 * QLab 5 (Figure 53), over its OSC API on TCP. The research behind it, and
 * what was checked against a real QLab 5.5.10: ../../../docs/QLAB.md.
 */

import { QLabPlayer } from './player.js';

export default {
  api: 1,
  kind: 'player',
  id: 'qlab',
  label: 'QLab',
  description: 'QLab 5 over OSC (TCP 53000): GO, pause and stop on a cue list, and the running clip\'s time for the display.',
  help: 'QLab can\'t follow a switcher by itself, so turn on the rules below: “Play” GOes the cue list (or resumes a paused clip). A new QLab 5 workspace makes up a 4-digit passcode and gives connections without one no access — copy it from Workspace Settings → Network → OSC Access. Only cues of the types listed count as clips; the rest (lights, audio, fades) are passed over.',
  via: [{ value: 'osc', label: 'OSC' }],
  relay: false,
  integrations: [],
  settings: [
    { key: 'host', label: 'QLab address', type: 'text', default: '127.0.0.1', required: true },
    { key: 'port', label: 'QLab OSC port', type: 'number', default: 53000, min: 1, max: 65535 },
    { key: 'workspace', label: 'Workspace', type: 'text', placeholder: 'the first one open', help: 'Its name (without .qlab5) or unique ID. Empty takes the first workspace QLab lists.' },
    { key: 'passcode', label: 'OSC passcode', type: 'password', help: 'Workspace Settings → Network → OSC Access. It needs Control for the rules to drive QLab.' },
    { key: 'cueList', label: 'Cue list', type: 'text', placeholder: 'the current one', help: 'Its name or number. Empty follows whichever list is current in QLab.' },
    { key: 'cueTypes', label: 'Cue types that are clips', type: 'list', default: ['Video'], help: 'QLab\'s type names, comma-separated: Video, Audio, Group, Text… Empty counts every cue but lists, carts and groups.' },
    { key: 'fps', label: 'Frame rate (display)', type: 'number', default: 25, min: 1, max: 120, help: 'QLab reports time in seconds; this is only for showing frames.' },
  ],
  create: ({ settings, log }) => new QLabPlayer({ settings, log }),
  async testRig() {
    const { startQLabSim } = await import('./sim.mjs');
    const sim = await startQLabSim({ port: 0 });
    return {
      settings: { host: '127.0.0.1', port: sim.port, passcode: sim.passcode },
      sim,
      close: () => sim.close(),
    };
  },
};
