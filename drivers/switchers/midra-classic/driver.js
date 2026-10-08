/*
 * Analog Way Midra — the range before Midra 4K: Pulse², Eikos², Saphyr,
 * SmartMatriX², QuickMatriX, QuickVu — on Analog Way's mnemonic protocol,
 * TCP 10500 (server/lib/analogway.js). Everything here is from openRCS,
 * which drove a real Pulse² with it; no other model has met it.
 *
 * A screen's layers are PRinp[screen, ctx, layer]: ctx 0 is program and ctx
 * 1 preview, fixed. Layer 0 is the frame (background) layer, whose values are
 * stored frames, so it never counts as an input; the live layers are 1 up to
 * SCmly[screen] (a Pulse² has one: SCmly 2). A source is an input number,
 * 1–10, with 0 none and 11 colour.
 *
 * An input is ON AIR on a screen when it is the source of a live layer in
 * program — and while a take is running, in preview too, so a clip rolls as
 * the mix starts. It is in PREVIEW when it is a source in preview.
 *
 * The traps, all seen on a Pulse²:
 *  - The take GCtak[screen] is dead while CTpmu (preset-update mode) is 1,
 *    which is where RCS2 leaves it: accepted, latched at 1, nothing moves.
 *    This driver turns it off before a take. A take is pulsed 0 then 1, and
 *    the device drops it back to 0 when the transition is done.
 *  - The cut is the T-bar GCtba[screen], 0–10000, and only lands if it is
 *    seen to travel: the middle, then the far end 50 ms later.
 *  - A source the Midra will not show (an input with no signal) is dropped
 *    without an error, so a select is read back.
 *  - The frame has no input labels; names come from the settings, or the
 *    Pulse²'s own list.
 *  - A Pulse² may take only one control session: with RCS2 or openRCS
 *    connected, this one can be refused.
 */

import { EventEmitter } from 'node:events';
import { AwLink, PORT } from '../../../server/lib/analogway.js';

export { PORT };
const SCREENS = 2;
const INPUTS = 10;
const BAR = 10000;
const FAST_MS = 100;
const SLOW_MS = 400;
const CONFIG_MS = 5000;
const READBACK_MS = 350;
/* GCtak at 1 for longer than this is a latched take, not a transition. */
const LONGEST_TAKE_MS = 10000;

/* DEV, as far as it is known: 259 is the PLS350, sold as the Pulse². */
const MODELS = { 259: 'Pulse²' };
const PULSE2_INPUTS = ['Input 1', 'Input 2', 'Input 3', 'Input 4', 'HDMI 1', 'HDMI 2', 'SDI 1', 'SDI 2', 'SDI 3', 'SDI 4'];

const input = (v) => (Number.isInteger(v) && v >= 1 && v <= INPUTS ? v : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MidraClassicDriver extends EventEmitter {
  constructor({ host, port = PORT, screens = [], layer = 1, names = [], log = () => {} }) {
    super();
    this.wantScreens = screens.map((s) => Number(String(s).replace(/^S/i, '')) - 1).filter((n) => n >= 0 && n < SCREENS);
    this.layer = layer;
    this.names = names;
    this.log = log;
    this.online = false;
    this.taking = new Map(); // screen → when its take started
    this.tak = new Map();    // screen → last GCtak seen
    this.link = new AwLink({ host, port, family: 'midra', log });
    this.link.on('connected', () => this.#start());
    this.link.on('disconnected', (why) => this.#stop(this.wrongFamily || refused(why)));
    this.link.on('value', (mnem, idx, v) => { if (mnem === 'GCtak') this.#tak(idx[0], v); this.#changed(); });
    this.link.on('nak', (code) => { if ((this.naks = (this.naks || 0) + 1) <= 3) this.log(`Midra refused a command (E${code})`); });
  }

  connect() {
    this.emit('status', 'connecting');
    this.link.connect();
  }

  close() {
    this.#stop();
    this.link.close();
  }

  #start() {
    this.toldPmu = false;
    this.timers = [
      setInterval(() => this.#fast(), FAST_MS),
      setInterval(() => this.#slow(), SLOW_MS),
      setInterval(() => this.#config(), CONFIG_MS),
    ];
    this.#config();
  }

  #stop(why) {
    for (const t of this.timers || []) clearInterval(t);
    this.timers = [];
    this.taking.clear();
    this.tak.clear();
    if (why !== undefined || this.online) this.emit('status', 'offline', why);
    this.online = false;
  }

  /* ------------------------------------------------ reading */

  v(mnem, ...idx) { return this.link.value(mnem, idx); }

  screens() {
    const all = Array.from({ length: SCREENS }, (_, s) => s).filter((s) => this.v('SCssh', s) > 0);
    return this.wantScreens.length ? all.filter((s) => this.wantScreens.includes(s)) : all;
  }

  /** The live layers: 1 up to SCmly (layer 0 is the frame layer). */
  layers(s) { return Array.from({ length: Math.max(0, Math.min(8, this.v('SCmly', s) || 0) - 1) }, (_, k) => k + 1); }

  #config() {
    this.link.raw('?');
    const asks = [['CTpmu', []]];
    for (let s = 0; s < SCREENS; s += 1) asks.push(['SCssh', [s]], ['SCmly', [s]], ['GCtba', [s]]);
    for (let i = 0; i < INPUTS; i += 1) asks.push(['INava', [i]]);
    this.link.ask(asks);
  }

  #fast() { this.link.ask(this.screens().map((s) => ['GCtak', [s]])); }

  #slow() {
    const asks = [];
    for (const s of this.screens()) for (const l of this.layers(s)) asks.push(['PRinp', [s, 0, l]], ['PRinp', [s, 1, l]]);
    this.link.ask(asks);
  }

  /** A take is running from GCtak rising until it drops back to 0. */
  #tak(s, v) {
    const was = this.tak.get(s);
    this.tak.set(s, v);
    if (v === 1 && was === 0) this.taking.set(s, Date.now());
    /* The 0 of our own 0-then-1 pulse, echoed, is not the end of the take. */
    if (v === 0 && Date.now() - (this.taking.get(s) ?? 0) > 300) this.taking.delete(s);
  }

  #inputs() {
    const named = MODELS[this.v('DEV')] === 'Pulse²' ? PULSE2_INPUTS : [];
    return Array.from({ length: INPUTS }, (_, i) => i + 1).filter((id) => this.v('INava', id - 1) === 1).map((id) => {
      const name = this.names[id - 1] || named[id - 1] || `Input ${id}`;
      return { id, name, short: name.replace(/\s+/g, '').slice(0, 4).toUpperCase() };
    });
  }

  #ready() {
    if (this.v('DEV') == null || this.v('CTpmu') == null) return false;
    for (let s = 0; s < SCREENS; s += 1) if (this.v('SCssh', s) == null) return false;
    for (let i = 0; i < INPUTS; i += 1) if (this.v('INava', i) == null) return false;
    for (const s of this.screens()) {
      if (this.v('SCmly', s) == null) return false;
      for (const l of this.layers(s)) if (this.v('PRinp', s, 0, l) == null || this.v('PRinp', s, 1, l) == null) return false;
    }
    return true;
  }

  #changed() {
    if (this.pending) return;
    this.pending = setImmediate(() => { this.pending = null; this.#recompute(); });
  }

  #recompute() {
    if (this.wrongFamily) return;
    if (!this.online) {
      const dev = this.v('DEV');
      if (dev != null && dev < 256) {
        this.wrongFamily = 'this is a LiveCore (Ascender, NeXtage…), not a Midra — choose “Analog Way LiveCore”';
        this.link.close();
        return;
      }
      if (!this.#ready()) return;
      this.online = true;
      this.emit('status', 'online');
      this.emit('state', { device: { model: MODELS[dev] || `Midra (DEV ${dev})` }, inputs: this.#inputs() });
    }
    for (const [s, at] of this.taking) if (Date.now() - at > LONGEST_TAKE_MS) this.taking.delete(s);
    const tally = {};
    let program = null;
    let preview = null;
    let inTransition = false;
    const mark = (id, k) => { if (id != null) tally[id] = { ...(tally[id] || { program: false, preview: false }), [k]: true }; };
    for (const s of this.screens()) {
      const moving = this.taking.has(s);
      if (moving) inTransition = true;
      for (const l of this.layers(s)) {
        const a = input(this.v('PRinp', s, 0, l));
        const b = input(this.v('PRinp', s, 1, l));
        mark(a, 'program');
        mark(b, moving ? 'program' : 'preview');
        if (b != null && moving) mark(b, 'preview');
        if (a != null && (program == null || s === this.screens()[0])) program = a;
        if (b != null && (preview == null || s === this.screens()[0])) preview = b;
      }
    }
    this.emit('state', { tally, program, preview, inTransition });
  }

  /* ------------------------------------------------ commands */

  #screensOrThrow() {
    if (!this.online) throw new Error('the Midra is not connected');
    const list = this.screens();
    if (!list.length) throw new Error('no screen in service');
    return list;
  }

  /** The take does nothing in preset-update mode, so make sure it is off. */
  #takeMode() {
    if (this.v('CTpmu') === 0) return;
    this.link.set('CTpmu', [], 0);
    if (!this.toldPmu) this.log('Midra: preset-update mode off — a take does nothing while it is on (RCS2 turns it on)');
    this.toldPmu = true;
  }

  async auto() {
    const list = this.#screensOrThrow();
    this.#takeMode();
    for (const s of list) {
      this.taking.set(s, Date.now());
      this.link.set('GCtak', [s], 0);
      this.link.set('GCtak', [s], 1);
    }
    this.#changed();
  }

  async cut() {
    const list = this.#screensOrThrow();
    this.#takeMode();
    const at = await Promise.all(list.map((s) => this.link.get('GCtba', [s])));
    list.forEach((s, i) => this.link.set('GCtba', [s], BAR / 2));
    await sleep(50);
    list.forEach((s, i) => this.link.set('GCtba', [s], (at[i] ?? 0) >= BAR / 2 ? 0 : BAR));
    setTimeout(() => this.#slow(), 60);
  }

  /** Put an input on the chosen live layer in preview (ctx 1) or program (ctx 0), and check it landed. */
  async #source(id, ctx) {
    const targets = this.#screensOrThrow().map((s) => {
      const layers = this.layers(s);
      const l = layers.includes(this.layer) ? this.layer : layers[0];
      if (l == null) throw new Error(`screen ${s + 1} has no live layer to put an input on`);
      return [s, l];
    });
    for (const [s, l] of targets) this.link.set('PRinp', [s, ctx, l], Number(id));
    await sleep(READBACK_MS);
    const got = await Promise.all(targets.map(([s, l]) => this.link.get('PRinp', [s, ctx, l])));
    const missed = targets.filter((_, i) => got[i] !== Number(id)).map(([s]) => s + 1);
    if (missed.length) throw new Error(`the Midra did not put input ${id} on screen ${missed.join(', ')} — it refuses an input with no signal`);
  }

  async setPreview(id) { return this.#source(id, 1); }
  async setProgram(id) { return this.#source(id, 0); }
}

/* A refused connection is most often another control session. */
const refused = (why) => (/ECONNREFUSED/.test(why || '') ? `${why} — is RCS2 or openRCS connected? A Pulse² takes one control session` : why);
