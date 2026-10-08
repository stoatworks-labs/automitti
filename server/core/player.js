/*
 * The host for whichever media-player driver is chosen — Mitti today, anything
 * that plays clips tomorrow. Knows no player by name.
 *
 * The rules, the clip display, the status page and the Bonjour announcements
 * read `snapshot()` and call `act()`; both are passed straight to the driver
 * after its contract has been checked. The contract is in core/contract.js.
 */

import { EventEmitter } from 'node:events';
import { checkInstance, normaliseSettings, PLAYER_ACTIONS } from './contract.js';
import { lib } from '../lib/index.js';

const OFFLINE = Object.freeze({
  online: false, error: null, playing: false, playhead: 0, fps: 25, updatedAt: null,
  current: { name: null, index: null, trtSec: null }, next: { name: null, index: null, trtSec: null },
  elapsedSec: null, remainingSec: null, cues: [], summary: '', detail: {},
});

export class Player extends EventEmitter {
  /**
   * @param {{config: () => object}} opts  `config` is the DEVICE's settings
   *   (config.js normaliseDevice): its `player` and relay `destinations`.
   */
  constructor({ config, registry, log = () => {} }) {
    super();
    this.config = config;
    this.registry = registry;
    this.log = log;
    this.driver = null;
    this.descriptor = null;
    this.error = null;
    this.onChange = (why) => this.emit('change', why);
  }

  settings(c = this.config()) {
    const d = this.registry.player(c.player.type);
    return d ? normaliseSettings(d.settings, c.player.settings?.[d.id]) : {};
  }

  /** Whether going from device settings `a` to `b` needs the driver made again. */
  changes(a, b = this.config()) {
    return a.player.type !== b.player.type || JSON.stringify(this.settings(a)) !== JSON.stringify(this.settings(b));
  }

  async start() { await this.#open(); }

  async stop() {
    const d = this.driver;
    this.driver = null;
    if (!d) return;
    d.off('change', this.onChange);
    try { await d.stop(); } catch (err) { this.log(`player stop: ${err.message}`); }
  }

  async reconfigure(prev) {
    if (this.changes(prev)) {
      await this.stop();
      await this.#open();
    }
    this.emit('change', 'config');
  }

  async #open() {
    const c = this.config().player;
    this.error = null;
    this.descriptor = this.registry.player(c.type);
    if (!this.descriptor) {
      if (c.type !== 'none') this.error = `no player driver called "${c.type}" is installed`;
      this.emit('change', 'config');
      return;
    }
    try {
      const driver = this.descriptor.create({
        settings: this.settings(),
        log: this.log,
        lib,
        /* Where to re-send the player's feedback, read live so edits apply at once. */
        destinations: () => this.config().destinations,
      });
      const bad = checkInstance(driver, 'player');
      if (bad.length) throw new Error(`the ${this.descriptor.id} driver is ${bad.join('; ')}`);
      this.driver = driver;
      driver.on('change', this.onChange);
      await driver.start();
    } catch (err) {
      this.error = err.message;
      this.log(`player: ${err.message}`);
    }
    this.emit('change', 'config');
  }

  /** One transport action. `via` picks the link on players that have more than one. */
  async act(action, via) {
    if (!PLAYER_ACTIONS.includes(action)) throw new Error(`unknown player action ${action}`);
    if (!this.driver) throw new Error('no player is connected');
    return this.driver.act(action, { via });
  }

  /** A raw message in the player's own protocol, for drivers that take one. */
  command(address, args = []) {
    if (!this.driver?.command) throw new Error(`${this.descriptor?.label || 'this player'} takes no raw commands`);
    return this.driver.command(address, args);
  }

  bonjour() {
    try { return this.driver?.bonjour?.() || []; } catch { return []; }
  }

  snapshot() {
    const base = { type: this.config().player.type, label: this.descriptor?.label || 'None', at: Date.now() };
    if (!this.driver) return { ...OFFLINE, ...base, error: this.error };
    let s;
    try { s = this.driver.snapshot(); } catch (err) { s = { error: err.message }; }
    return {
      ...OFFLINE,
      ...s,
      current: { ...OFFLINE.current, ...(s.current || {}) },
      next: { ...OFFLINE.next, ...(s.next || {}) },
      ...base,
      error: s.error || this.error || null,
    };
  }
}
