/*
 * Analog Way Pulse 4K / Midra 4K platform (QuickVu, Pulse, Eikos,
 * QuickMatrix; the "mng" object model) over AWJ, TCP 10606.
 *
 * A layer switcher has no single "program input". An input is ON AIR on a
 * screen when it is the source of a fitted layer in that screen's program
 * buffer — and while a transition is running, in either buffer, so a clip
 * starts rolling as its take begins rather than after the mix. An input is in
 * PREVIEW when it is a layer source in the preview buffer.
 *
 * Paths (proven against the Midra 4K simulator 3.2.29; the model was read off
 * a live Pulse 4K on 3.3.10 by LivePremier Plus):
 *
 *   DeviceObject/transition/$screen/@items/<s>/status/@props/transition
 *       AT_UP | AT_DOWN when resting — the suffix names the PROGRAM buffer —
 *       anything else is a take in flight
 *   DeviceObject/$screen/@items/<s>/$preset/@items/<UP|DOWN>/$liveLayer/@items/<k>/source/@props/input
 *       NONE | INPUT_<n> | COLOR
 *   DeviceObject/preconfig/status/$state/@items/CURRENT/$screen/@items/<s>/@props/enable
 *   DeviceObject/preconfig/status/$state/@items/CURRENT/$screen/@items/<s>/$liveLayer/@items/<k>/@props/mode
 *       the APPLIED configuration: which screens and layers exist
 *   DeviceObject/transition/$screen/@items/<s>/control/@props/xTake | xCut   (write true)
 *
 * AWJ answers a `get` but pushes nothing, so this polls one socket: the
 * transition state every 50 ms (the take is what must be caught quickly),
 * layer sources every 400 ms, the configuration every 5 s.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

export const AWJ_PORT = 10606;
const MAX_SCREENS = 4;
const MAX_LAYERS = 8;
const INPUTS = 16;
const FAST_MS = 50;
const SLOW_MS = 400;
const CONFIG_MS = 5000;

const T = (s) => `DeviceObject/transition/$screen/@items/${s}/status/@props/transition`;
const SRC = (s, buf, k) => `DeviceObject/$screen/@items/${s}/$preset/@items/${buf}/$liveLayer/@items/${k}/source/@props/input`;
const EN = (s) => `DeviceObject/preconfig/status/$state/@items/CURRENT/$screen/@items/${s}/@props/enable`;
const MODE = (s, k) => `DeviceObject/preconfig/status/$state/@items/CURRENT/$screen/@items/${s}/$liveLayer/@items/${k}/@props/mode`;
const CTRL = (s, prop) => `DeviceObject/transition/$screen/@items/${s}/control/@props/${prop}`;

const RESTING = new Set(['AT_UP', 'AT_DOWN']);
const inputId = (v) => { const m = /^INPUT_(\d+)$/.exec(String(v || '')); return m ? Number(m[1]) : null; };

export class MidraDriver extends EventEmitter {
  constructor({ host, port = AWJ_PORT, screens = [], layer = 1, log = () => {} }) {
    super();
    this.host = host;
    this.port = port;
    this.wantScreens = screens.map((s) => Number(String(s).replace(/^S/i, ''))).filter((n) => n >= 1 && n <= MAX_SCREENS);
    this.layer = layer;
    this.log = log;
    this.values = new Map();
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.timers = [];
    this.closing = false;
    this.online = false;
  }

  capabilities() { return { cut: true, auto: true, preview: true, program: true }; }

  connect() { this.closing = false; this.#open(); }

  close() {
    this.closing = true;
    this.#teardown();
  }

  #teardown() {
    this.timers.forEach(clearInterval);
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.socket?.destroy();
    this.socket = null;
    this.online = false;
  }

  #open() {
    this.emit('status', 'connecting');
    this.values.clear();
    this.buf = Buffer.alloc(0);
    const s = net.connect({ host: this.host, port: this.port });
    this.socket = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
    s.on('connect', () => {
      this.lastReply = Date.now();
      this.#get(['DeviceObject/system/@props/platformLabel']);
      this.#readConfig();
      this.timers.push(setInterval(() => this.#fast(), FAST_MS));
      this.timers.push(setInterval(() => this.#slow(), SLOW_MS));
      this.timers.push(setInterval(() => this.#readConfig(), CONFIG_MS));
    });
    s.on('data', (d) => this.#onData(d));
    s.on('error', (err) => { this.lastError = err.message; });
    s.on('close', () => {
      this.#teardown();
      this.emit('status', 'offline', this.lastError || 'connection closed');
      if (!this.closing) this.timers.push(setTimeout(() => this.#open(), 3000));
    });
  }

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let i;
    let touched = false;
    while ((i = this.buf.indexOf(4)) >= 0) {
      const text = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 1);
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      this.lastReply = Date.now();
      if (msg && typeof msg.path === 'string') {
        if (this.values.get(msg.path) !== msg.value) touched = true;
        this.values.set(msg.path, msg.value);
        if (msg.path.endsWith('platformLabel')) this.platform = msg.value;
      }
    }
    if (touched) this.#recompute();
  }

  #get(paths) {
    if (!this.socket) return;
    this.socket.write(paths.map((path) => `${JSON.stringify({ op: 'get', path })}\x04`).join(''));
  }

  #set(path, value) {
    this.socket?.write(`${JSON.stringify({ op: 'replace', path, value })}\x04`);
  }

  /** Screens in service and in scope. */
  screens() {
    const all = Array.from({ length: MAX_SCREENS }, (_, k) => k + 1).filter((s) => this.values.get(EN(s)) === true);
    return this.wantScreens.length ? all.filter((s) => this.wantScreens.includes(s)) : all;
  }

  layers(s) {
    return Array.from({ length: MAX_LAYERS }, (_, k) => k + 1).filter((k) => {
      const m = this.values.get(MODE(s, k));
      return typeof m === 'string' && m !== 'DISABLE';
    });
  }

  #readConfig() {
    const paths = [];
    for (let s = 1; s <= MAX_SCREENS; s += 1) {
      paths.push(EN(s));
      for (let k = 1; k <= MAX_LAYERS; k += 1) paths.push(MODE(s, k));
    }
    this.#get(paths);
    /* A socket that has stopped answering is a dead session, even if TCP says otherwise. */
    if (this.online && Date.now() - this.lastReply > 10000) { this.lastError = 'the switcher stopped answering'; this.socket?.destroy(); }
  }

  #fast() { this.#get(this.screens().map(T)); }

  #slow() {
    const paths = [];
    for (const s of this.screens()) for (const k of this.layers(s)) paths.push(SRC(s, 'UP', k), SRC(s, 'DOWN', k));
    this.#get(paths);
  }

  /**
   * Online only once the first full read is in: the platform, every screen's
   * enable, and for the screens in scope their transition state and every
   * fitted layer's source in both buffers. Before that a select would find no
   * layer to write and a take no screen — and the tally would be a guess.
   */
  #ready() {
    if (!this.platform) return false;
    for (let s = 1; s <= MAX_SCREENS; s += 1) if (!this.values.has(EN(s))) return false;
    for (const s of this.screens()) {
      if (!this.values.has(T(s))) return false;
      for (const k of this.layers(s)) if (!this.values.has(SRC(s, 'UP', k)) || !this.values.has(SRC(s, 'DOWN', k))) return false;
    }
    return true;
  }

  #recompute() {
    if (!this.online) {
      if (!this.#ready()) return;
      this.online = true;
      this.emit('status', 'online');
      this.emit('state', {
        device: { model: this.platform },
        inputs: Array.from({ length: INPUTS }, (_, k) => ({ id: k + 1, name: `Input ${k + 1}`, short: `IN${k + 1}` })),
      });
    }
    const tally = {};
    let program = null;
    let preview = null;
    let inTransition = false;
    const mark = (id, key) => { if (id != null) tally[id] = { ...(tally[id] || { program: false, preview: false }), [key]: true }; };
    for (const s of this.screens()) {
      const t = this.values.get(T(s));
      if (typeof t !== 'string') continue;
      const pgm = t.endsWith('DOWN') ? 'DOWN' : 'UP';
      const pvw = pgm === 'UP' ? 'DOWN' : 'UP';
      const moving = !RESTING.has(t);
      if (moving) inTransition = true;
      for (const k of this.layers(s)) {
        const a = inputId(this.values.get(SRC(s, pgm, k)));
        const b = inputId(this.values.get(SRC(s, pvw, k)));
        mark(a, 'program');
        mark(b, moving ? 'program' : 'preview');
        if (b != null && moving) mark(b, 'preview');
        /* The primary program/preview input: the top fitted layer with a source on the first screen. */
        if (a != null && (program == null || s === this.screens()[0])) program = a;
        if (b != null && (preview == null || s === this.screens()[0])) preview = b;
      }
    }
    this.emit('state', { tally, program, preview, inTransition });
  }

  #each(fn) {
    const list = this.screens();
    if (!list.length) throw new Error('no screen in service');
    for (const s of list) fn(s);
  }

  async cut() { this.#each((s) => this.#set(CTRL(s, 'xCut'), true)); }
  async auto() { this.#each((s) => this.#set(CTRL(s, 'xTake'), true)); }

  /** Put an input on the Mitti layer of the preview (or program) buffer. */
  #source(id, which) {
    this.#each((s) => {
      const t = this.values.get(T(s));
      const pgm = String(t).endsWith('DOWN') ? 'DOWN' : 'UP';
      const buf = which === 'program' ? pgm : (pgm === 'UP' ? 'DOWN' : 'UP');
      const k = this.layers(s).includes(this.layer) ? this.layer : this.layers(s)[0];
      if (!k) throw new Error(`screen ${s} has no layer to put an input on`);
      this.#set(SRC(s, buf, k), `INPUT_${Number(id)}`);
    });
    setTimeout(() => this.#slow(), 60);
  }

  async setPreview(id) { this.#source(id, 'preview'); }
  async setProgram(id) { this.#source(id, 'program'); }
}
