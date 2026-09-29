/*
 * The real switcher, behind one small model every other part reads:
 *
 *   inputs    [{ id, name, short }]   id is the switcher's own input number
 *   program   id | null               the main program source
 *   preview   id | null
 *   tally     { [id]: { program, preview } }
 *
 * `tally` is not just program/preview: on a layer switcher (Pulse 4K / Midra
 * 4K) several inputs are on air at once, and during a transition both the
 * leaving and the arriving source count as on air.
 *
 * Drivers emit `state` with a partial model and implement cut(), auto(),
 * setPreview(id), setProgram(id). `manual` has no device — tally is set from
 * the page or HTTP, which is how anything Companion can see gets in.
 */

import { EventEmitter } from 'node:events';
import { V160hdDriver } from './v160hd.js';
import { MidraDriver } from './midra.js';

const DRIVERS = {
  v160hd: V160hdDriver,
  midra: MidraDriver,
};

export const LABELS = {
  none: 'None',
  v160hd: 'Roland V-160HD',
  midra: 'Analog Way Pulse 4K / Midra 4K',
  manual: 'Manual / HTTP tally',
};

const emptyModel = () => ({ inputs: [], program: null, preview: null, tally: {}, inTransition: false, device: null });

export class Switcher extends EventEmitter {
  constructor({ config, log = () => {} }) {
    super();
    this.config = config;
    this.log = log;
    this.driver = null;
    this.status = 'offline';
    this.error = null;
    this.model = emptyModel();
  }

  async start() { this.#open(); }

  stop() {
    this.driver?.close();
    this.driver = null;
  }

  async reconfigure(prev) {
    const a = prev.switcher; const b = this.config().switcher;
    if (a.type !== b.type || a.host !== b.host || a.port !== b.port || a.password !== b.password || a.layer !== b.layer
      || JSON.stringify(a.screens) !== JSON.stringify(b.screens)) {
      this.stop();
      this.model = emptyModel();
      this.driverTally = false;
      this.#open();
    }
    this.emit('change');
  }

  #open() {
    const c = this.config().switcher;
    this.status = 'offline';
    this.error = null;
    if (c.type === 'manual') {
      this.status = 'online';
      this.model.inputs = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Input ${i + 1}`, short: `IN${i + 1}` }));
      this.emit('change');
      return;
    }
    const Driver = DRIVERS[c.type];
    if (!Driver || !c.host) { this.emit('change'); return; }
    this.driver = new Driver({ host: c.host, port: c.port || undefined, password: c.password, screens: c.screens, layer: c.layer, log: this.log });
    this.driver.on('status', (status, error) => {
      this.status = status;
      this.error = error || null;
      if (status !== 'online') this.model.tally = {};
      this.emit('change');
    });
    this.driver.on('state', (patch) => this.#apply(patch));
    this.driver.connect();
  }

  #apply(patch) {
    const before = JSON.stringify(this.model);
    Object.assign(this.model, patch);
    /* A driver that reports tally (the V-160HD pushes it, the Midra computes
       it from layers) is the authority on it — a bus read must not overwrite
       it, or a take in flight flickers Mitti's input off air. Only a driver
       with no tally of its own gets it derived from program/preview. */
    if ('tally' in patch) this.driverTally = true;
    else if (!this.driverTally && ('program' in patch || 'preview' in patch)) this.model.tally = tallyOf(this.model);
    if (JSON.stringify(this.model) !== before) {
      this.emit('change');
      this.emit('tally');
    }
  }

  /** The input Mitti feeds, resolved from the setting (a number or a name). */
  mittiInput() {
    const raw = this.config().switcher.mittiInput;
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isInteger(n) && this.model.inputs.some((i) => i.id === n)) return n;
    const lower = raw.toLowerCase();
    const hit = this.model.inputs.find((i) => i.name.toLowerCase() === lower || String(i.short).toLowerCase() === lower);
    if (hit) return hit.id;
    return Number.isInteger(n) ? n : null;
  }

  tallyOf(id) {
    const t = this.model.tally[id];
    return { program: !!t?.program, preview: !!t?.preview };
  }

  async command(action, input) {
    const c = this.config().switcher;
    const id = input == null ? null : Number(input);
    if (c.type === 'manual') {
      if (action === 'program') this.#apply({ program: id });
      else if (action === 'preview') this.#apply({ preview: id });
      else if (action === 'cut' || action === 'auto') this.#apply({ program: this.model.preview, preview: this.model.program });
      return;
    }
    if (!this.driver || this.status !== 'online') throw new Error('the switcher is not connected');
    switch (action) {
      case 'cut': return this.driver.cut();
      case 'auto': return this.driver.auto();
      case 'preview': return this.driver.setPreview(id);
      case 'program': return this.driver.setProgram(id);
      default: throw new Error(`unknown switcher action ${action}`);
    }
  }

  snapshot() {
    const c = this.config().switcher;
    return {
      type: c.type,
      label: LABELS[c.type],
      status: c.type === 'none' ? 'off' : this.status,
      error: this.error,
      ...this.model,
      mittiInput: this.mittiInput(),
      capabilities: this.driver?.capabilities?.() || { cut: true, auto: true, preview: true, program: true },
    };
  }
}

export function tallyOf({ program, preview }) {
  const t = {};
  if (preview != null) t[preview] = { program: false, preview: true };
  if (program != null) t[program] = { program: true, preview: preview === program };
  return t;
}
