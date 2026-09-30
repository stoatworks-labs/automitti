/*
 * No device: tally is set from the control page or over HTTP
 * (POST /api/switcher {action: 'program'|'preview'|'cut'|'auto', input}).
 * That is how anything that can send HTTP — Companion, a show-control script,
 * a switcher automitti has no driver for — can feed it.
 *
 * Also the smallest complete switcher driver there is, which makes it the one
 * to read first when writing another.
 */

import { EventEmitter } from 'node:events';

class ManualSwitcher extends EventEmitter {
  constructor({ inputs }) {
    super();
    this.state = {
      inputs: Array.from({ length: inputs }, (_, i) => ({ id: i + 1, name: `Input ${i + 1}`, short: `IN${i + 1}` })),
      program: null,
      preview: null,
    };
  }

  connect() {
    this.emit('status', 'online');
    this.emit('state', { ...this.state, device: { model: 'Manual' } });
  }

  close() {}

  #set(patch) {
    Object.assign(this.state, patch);
    this.emit('state', patch);
  }

  async cut() { this.#set({ program: this.state.preview, preview: this.state.program }); }
  async auto() { return this.cut(); }
  async setPreview(id) { this.#set({ preview: id }); }
  async setProgram(id) { this.#set({ program: id }); }
}

export default {
  api: 1,
  kind: 'switcher',
  id: 'manual',
  label: 'Manual / HTTP tally',
  description: 'No device: program and preview are set from this page or over HTTP.',
  help: 'POST /api/switcher with {"action": "program" | "preview" | "cut" | "auto", "input": n} — from Companion’s HTTP action, for example.',
  inputCount: (settings) => settings.inputs,
  settings: [
    { key: 'inputs', label: 'Inputs', type: 'number', default: 20, min: 1, max: 200 },
  ],
  create: ({ settings }) => new ManualSwitcher(settings),
  async testRig() {
    return { settings: { inputs: 8 }, close: async () => {} };
  },
};
