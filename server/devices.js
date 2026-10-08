/*
 * The devices: one media player each — Mitti, or any player driver — with
 * everything that follows it: the switcher input it feeds, where its feedback
 * is relayed, the NDI tally sent to it, and the rules that drive it.
 *
 * Several run at once on the ONE switcher, the way several Mittis share one
 * real ATEM: the emulated ATEM is shared too, and each Mitti picks its own
 * input in its own ATEM settings.
 *
 * A device's parts read the device's settings (config.js normaliseDevice),
 * which are held here and swapped on a reconfigure. A device that is being
 * removed goes on reading its last settings until it has stopped, never a
 * config it is no longer in.
 */

import { EventEmitter } from 'node:events';
import { Player } from './core/player.js';
import { NdiTally } from './ndi/tally.js';
import { Rules } from './rules.js';
import { normaliseSettings } from './core/contract.js';

export class Device extends EventEmitter {
  constructor({ cfg, switcher, registry, ndiLibrary, log = () => {} }) {
    super();
    this.cfg = cfg;
    this.switcher = switcher;
    const config = () => this.cfg;
    this.player = new Player({ config, registry, log });
    this.ndi = new NdiTally({ config, library: ndiLibrary, switcher, log });
    this.rules = new Rules({ config, switcher, player: this.player, log });
    this.onChange = () => this.emit('change');
    for (const part of [this.player, this.ndi, this.rules]) part.on('change', this.onChange);
  }

  get id() { return this.cfg.id; }
  get name() { return this.cfg.name; }

  async start() {
    await this.player.start();
    await this.ndi.start();
    this.rules.start();
  }

  async reconfigure(next) {
    const prev = this.cfg;
    this.cfg = next;
    await this.player.reconfigure(prev);
    await this.ndi.reconfigure(prev);
    this.emit('change');
  }

  async stop() {
    this.rules.stop();
    this.ndi.close();
    await this.player.stop();
    for (const part of [this.player, this.ndi, this.rules]) part.off('change', this.onChange);
  }

  /** The switcher input it feeds, resolved from its setting (a number or a name). */
  input() { return this.switcher.inputOf(this.cfg.input); }

  snapshot() {
    const input = this.input();
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      input,
      tally: input == null ? { program: false, preview: false } : this.switcher.tallyOf(input),
      player: this.player.snapshot(),
      ndi: this.ndi.snapshot(),
      rules: this.rules.snapshot(),
    };
  }
}

export class Devices extends EventEmitter {
  constructor({ config, switcher, registry, log = () => {} }) {
    super();
    this.config = config;
    this.switcher = switcher;
    this.registry = registry;
    this.log = log;
    this.map = new Map(); // id → Device
    this.onChange = () => this.emit('change');
  }

  #create(cfg) {
    const device = new Device({
      cfg,
      switcher: this.switcher,
      registry: this.registry,
      ndiLibrary: () => this.config().ndi.library,
      /* Once there are several, every line says whose it is. */
      log: (m) => this.log(this.map.size > 1 ? `${this.map.get(cfg.id)?.name ?? cfg.name}: ${m}` : m),
    });
    device.on('change', this.onChange);
    this.map.set(cfg.id, device);
    return device;
  }

  async start() {
    for (const cfg of this.config().devices) await this.#create(cfg).start();
  }

  /** Bring the running devices in line with the settings. */
  async reconfigure() {
    const wanted = this.config().devices;
    const ids = new Set(wanted.map((d) => d.id));
    /* The removed go first, and every player whose settings change is stopped
       before any is started again, so a port one device gives up is free for
       another to take in the same save. */
    for (const [id, device] of this.map) {
      if (ids.has(id)) continue;
      this.map.delete(id);
      device.off('change', this.onChange);
      await device.stop();
      this.log(`${device.name} removed`);
    }
    for (const cfg of wanted) {
      const device = this.map.get(cfg.id);
      if (device?.player.changes(device.cfg, cfg)) await device.player.stop();
    }
    for (const cfg of wanted) {
      const device = this.map.get(cfg.id);
      if (device) await device.reconfigure(cfg);
      else {
        await this.#create(cfg).start();
        this.log(`${cfg.name} added`);
      }
    }
    this.emit('change');
  }

  async stop() {
    for (const device of this.map.values()) await device.stop();
  }

  /** In the settings' order. */
  list() {
    return this.config().devices.map((c) => this.map.get(c.id)).filter(Boolean);
  }

  /** By id, or by name (any case); the first device when none is given. */
  get(key) {
    if (key == null || key === '') return this.list()[0] || null;
    const k = String(key);
    return this.map.get(k) || this.list().find((d) => d.name.toLowerCase() === k.toLowerCase()) || null;
  }

  /** Every device's Bonjour services, keyed apart. */
  bonjour() {
    return this.list().flatMap((d) => d.player.bonjour().map((spec) => ({ ...spec, key: `player-${d.id}-${spec.key}` })));
  }

  /**
   * Settings for one more device of a player type: the next free id and name,
   * and its own value for each setting the driver marks `unique` (Mitti's
   * feedback port): one past the highest its devices use, or the default.
   */
  draft(type = 'mitti') {
    const c = this.config();
    const d = this.registry.player(type);
    const ids = new Set(c.devices.map((x) => x.id));
    const stem = type.slice(0, 26);
    let n = c.devices.length + 1;
    while (ids.has(`${stem}-${n}`)) n += 1;
    const settings = {};
    for (const f of d?.settings || []) {
      if (!f.unique || f.type !== 'number') continue;
      const taken = c.devices.filter((x) => x.player.type === type)
        .map((x) => normaliseSettings(d.settings, x.player.settings?.[type])[f.key]).filter((v) => v);
      const v = taken.length ? Math.max(...taken) + 1 : (f.default ?? f.min ?? 1);
      if (f.max == null || v <= f.max) settings[f.key] = v;
    }
    return { id: `${stem}-${n}`, name: `${d?.label || type} ${n}`, player: { type, settings: { [type]: settings } } };
  }

  snapshot() {
    const clashes = this.#clashes();
    return this.list().map((d) => ({ ...d.snapshot(), warnings: clashes.get(d.id) || [] }));
  }

  /* A `unique` setting two devices of one driver share — two Mittis told to
     send feedback to the same port. Empty and 0 ("any free port") are exempt. */
  #clashes() {
    const out = new Map();
    const note = (id, line) => out.set(id, [...(out.get(id) || []), line]);
    const first = new Map(); // "type:key:value" → device
    for (const device of this.list()) {
      const d = this.registry.player(device.cfg.player.type);
      if (!d) continue;
      const s = device.player.settings();
      for (const f of d.settings.filter((x) => x.unique)) {
        const v = s[f.key];
        if (!v) continue;
        const key = `${d.id}:${f.key}:${v}`;
        const other = first.get(key);
        if (!other) { first.set(key, device); continue; }
        note(device.id, `${f.label} ${v} is also ${other.name}'s`);
        note(other.id, `${f.label} ${v} is also ${device.name}'s`);
      }
    }
    return out;
  }
}
