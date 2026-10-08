/*
 * The host for whichever switcher driver is chosen. Knows no switcher by name.
 *
 * Everything else in automitti reads the one model this keeps:
 *
 *   inputs    [{ id, name, short }]
 *   program   id | null
 *   preview   id | null
 *   tally     { [id]: { program, preview } }
 *   inTransition, device
 *
 * and asks it for `inputOf(setting)` — which switcher input a device feeds,
 * from its setting (a number or a name) — and `tallyOf(id)`.
 *
 * The driver contract is in core/contract.js and docs/DRIVERS.md.
 */

import { EventEmitter } from 'node:events';
import { checkInstance, normaliseSettings } from './contract.js';
import { lib } from '../lib/index.js';

const emptyModel = () => ({ inputs: [], program: null, preview: null, tally: {}, inTransition: false, device: null });

export class Switcher extends EventEmitter {
  constructor({ config, registry, log = () => {} }) {
    super();
    this.config = config;
    this.registry = registry;
    this.log = log;
    this.driver = null;
    this.descriptor = null;
    this.status = 'offline';
    this.error = null;
    this.model = emptyModel();
    this.driverTally = false;
  }

  /** The chosen driver's settings, normalised against its schema. */
  settings(c = this.config()) {
    const d = this.registry.switcher(c.switcher.type);
    return d ? normaliseSettings(d.settings, c.switcher.settings?.[d.id]) : {};
  }

  async start() { this.#open(); }

  stop() {
    try { this.driver?.close(); } catch (err) { this.log(`switcher close: ${err.message}`); }
    this.driver = null;
  }

  async reconfigure(prev) {
    const a = prev.switcher.type; const b = this.config().switcher.type;
    const same = a === b && JSON.stringify(this.settings(prev)) === JSON.stringify(this.settings());
    if (!same) {
      this.stop();
      this.#open();
    }
    this.emit('change');
  }

  #open() {
    const c = this.config().switcher;
    this.model = emptyModel();
    this.driverTally = false;
    this.status = 'offline';
    this.error = null;
    this.descriptor = this.registry.switcher(c.type);
    if (!this.descriptor) {
      if (c.type !== 'none') this.error = `no switcher driver called "${c.type}" is installed`;
      this.emit('change');
      return;
    }
    const settings = this.settings();
    const missing = this.descriptor.settings.filter((f) => f.required && (settings[f.key] === '' || settings[f.key] == null));
    if (missing.length) {
      this.error = `needs ${missing.map((f) => f.label.toLowerCase()).join(', ')}`;
      this.emit('change');
      return;
    }
    let driver;
    try {
      driver = this.descriptor.create({ settings, log: this.log, lib });
      const bad = checkInstance(driver, 'switcher');
      if (bad.length) throw new Error(`the ${this.descriptor.id} driver is ${bad.join('; ')}`);
    } catch (err) {
      this.error = err.message;
      this.log(`switcher: ${err.message}`);
      this.emit('change');
      return;
    }
    this.driver = driver;
    driver.on('status', (status, error) => {
      this.status = status;
      this.error = error || null;
      if (status !== 'online') this.model.tally = {};
      this.emit('change');
      this.emit('tally');
    });
    driver.on('state', (patch) => this.#apply(patch));
    driver.on('error', (err) => this.log(`switcher: ${err?.message || err}`));
    driver.connect();
  }

  #apply(patch) {
    const before = JSON.stringify(this.model);
    Object.assign(this.model, patch);
    /* A driver that reports tally (the V-160HD pushes it, the Midra computes
       it from layers) is the authority on it — a bus read must not overwrite
       it, or a take in flight flickers the player's input off air. Only a
       driver with no tally of its own gets it derived from program/preview. */
    if ('tally' in patch) this.driverTally = true;
    else if (!this.driverTally && ('program' in patch || 'preview' in patch)) this.model.tally = tallyOf(this.model);
    if (JSON.stringify(this.model) !== before) {
      this.emit('change');
      this.emit('tally');
    }
  }

  /** A device's input, resolved from its setting (a number or a name). */
  inputOf(raw) {
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isInteger(n) && this.model.inputs.some((i) => i.id === n)) return n;
    const lower = raw.toLowerCase();
    const hit = this.model.inputs.find((i) => String(i.name).toLowerCase() === lower || String(i.short).toLowerCase() === lower);
    if (hit) return hit.id;
    return Number.isInteger(n) ? n : null;
  }

  tallyOf(id) {
    const t = this.model.tally[id];
    return { program: !!t?.program, preview: !!t?.preview };
  }

  /** How many inputs an emulated ATEM should carry for this driver. */
  inputCount() {
    const d = this.descriptor;
    if (!d) return 8;
    const n = typeof d.inputCount === 'function' ? d.inputCount(this.settings()) : d.inputCount;
    return Number.isInteger(n) && n > 0 ? n : 8;
  }

  async command(action, input) {
    if (!this.driver || this.status !== 'online') throw new Error('the switcher is not connected');
    const id = input == null ? null : Number(input);
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
      label: this.descriptor?.label || 'None',
      status: !this.descriptor ? 'off' : this.status,
      error: this.error,
      ...this.model,
      capabilities: { cut: true, auto: true, preview: true, program: true, ...(this.driver?.capabilities?.() || {}) },
    };
  }
}

export function tallyOf({ program, preview }) {
  const t = {};
  if (preview != null) t[preview] = { program: false, preview: true };
  if (program != null) t[program] = { program: true, preview: preview === program };
  return t;
}
