/*
 * Roland V-160HD over LAN: TCP 8023, one connection only (the unit's own
 * limit — RCS over LAN cannot run beside us).
 *
 * Written from Roland's Remote Control Guide and the working Companion client;
 * docs/V160HD.md has every command with where it came from. NOT yet run
 * against a real unit: tools/v160hd-sim.mjs is all it has spoken to.
 *
 * Dialect: the register form, `DTH:aaaaaa,vv;` to write and
 * `RQH:aaaaaa,ssssss;` to read, which every firmware accepts. CUT and AUTO
 * use the plain-text `CUT;`/`ATO;` from firmware 3.3, and the panel
 * button press/release before that.
 *
 *   login     "Enter password:" → "<pw>\n" → "Welcome to V-160HD."
 *   tally     DTH:0C0100,01 turns on TALLY AUTO SEND; the unit then pushes
 *             DTH:0C0000,<one byte per source> on every change
 *             (bit 0 = PGM, bit 1 = PST)
 *   buses     RQH:002100,000002 → PGM and PST source codes, re-read on each
 *             tally push and every 3 s (also the keepalive)
 *   names     RQH:02<code+10>00,000008 → 8-character label, once at connect
 *
 * Source ids here are the Roland source code + 1: HDMI 1–8 = 1–8, SDI 1–8 =
 * 9–16, STILL 1–16 = 17–32, INPUT 1–20 = 33–52.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

export const V160HD_PORT = 8023;
const REPLY_MS = 1000;
const GAP_MS = 25;
const POLL_MS = 3000;

const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

export function sourceToken(code) {
  if (code < 8) return `HDMI${code + 1}`;
  if (code < 16) return `SDI${code - 7}`;
  if (code < 32) return `STILL${code - 15}`;
  return `INPUT${code - 31}`;
}

/* Four characters is all an ATEM short name holds: HD1, SD8, ST16, IN20. */
const shortOf = (token) => token.replace(/^HDMI/, 'HD').replace(/^SDI/, 'SD').replace(/^STILL/, 'ST').replace(/^INPUT/, 'IN');

export const SOURCES = Array.from({ length: 52 }, (_, code) => {
  const token = sourceToken(code);
  return { id: code + 1, code, short: shortOf(token), name: token.replace(/(\D+)(\d+)/, '$1 $2') };
});

export class V160hdDriver extends EventEmitter {
  constructor({ host, port = V160HD_PORT, password = '', log = () => {} }) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.log = log;
    this.socket = null;
    this.buf = '';
    this.authed = false;
    this.queue = [];
    this.inFlight = null;
    this.version = null;
    this.names = new Map();
    this.closing = false;
    this.timers = [];
  }

  capabilities() { return { cut: true, auto: true, preview: true, program: true }; }

  connect() {
    this.closing = false;
    this.#open();
  }

  close() {
    this.closing = true;
    this.#teardown();
  }

  #teardown() {
    this.timers.forEach(clearTimeout);
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const q of this.queue) q.reject(new Error('disconnected'));
    this.queue = [];
    if (this.inFlight) { clearTimeout(this.inFlight.timer); this.inFlight.reject(new Error('disconnected')); }
    this.inFlight = null;
    this.socket?.destroy();
    this.socket = null;
    this.authed = false;
  }

  #open() {
    this.emit('status', 'connecting');
    this.buf = '';
    const s = net.connect({ host: this.host, port: this.port });
    this.socket = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
    s.on('data', (d) => this.#onData(d));
    s.on('error', (err) => { this.lastError = err.message; });
    s.on('close', () => {
      const was = this.authed;
      this.#teardown();
      this.emit('status', 'offline', this.lastError || (was ? 'connection closed' : 'could not log in'));
      if (!this.closing) this.timers.push(setTimeout(() => this.#open(), 5000));
    });
    /* No prompt at all within 5 s: a unit that is not a V-160HD, or one
       already serving another client. */
    this.timers.push(setTimeout(() => {
      if (!this.authed && this.socket === s) { this.lastError = 'no login prompt (is another client connected?)'; s.destroy(); }
    }, 5000));
  }

  #onData(chunk) {
    /* Strip STX, XON/XOFF, NUL and telnet IAC noise; keep ACK (0x06) as a token. */
    let text = '';
    for (const b of chunk) {
      if (b === 0x06) text += 'ACK;';
      else if (b === 0x02 || b === 0x11 || b === 0x13 || b === 0x00 || b >= 0xf0) continue;
      else text += String.fromCharCode(b);
    }
    this.buf += text;
    if (!this.authed) {
      if (/Enter password:?/i.test(this.buf)) {
        this.buf = this.buf.replace(/[\s\S]*Enter password:?/i, '');
        this.socket.write(`${this.password}\n`);
      }
      if (/Welcome to V-160HD\.?/i.test(this.buf)) {
        this.buf = this.buf.replace(/[\s\S]*Welcome to V-160HD\.?/i, '');
        this.authed = true;
        this.#onLogin();
      } else if (/(incorrect|invalid|wrong|denied)/i.test(this.buf)) {
        this.lastError = 'the password was refused';
        this.socket.destroy();
      }
      if (!this.authed) return;
    }
    let i;
    while ((i = this.buf.indexOf(';')) >= 0) {
      const frame = this.buf.slice(0, i).replace(/[\r\n]/g, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (frame) this.#onFrame(frame);
    }
    if (this.buf.length > 8192) this.buf = '';
  }

  async #onLogin() {
    this.emit('status', 'online');
    this.emit('state', { inputs: SOURCES.map(({ id, name, short }) => ({ id, name, short })), device: { model: 'V-160HD' } });
    this.request('VER;', /^VER/).then((f) => {
      this.version = /VER:V-160HD[,:]\s*([\d.]+)/i.exec(f)?.[1] || null;
      this.emit('state', { device: { model: 'V-160HD', version: this.version } });
    }).catch(() => {});
    /* Fire and forget: clients found the unit often never ACKs this write. */
    this.#write('DTH:0C0100,01;');
    this.#readBuses();
    this.request('RQH:0C0000,000034;', /^DTH:0C0000,/).then((f) => this.#onFrame(f)).catch(() => {});
    this.#readNames();
    this.timers.push(setInterval(() => this.#readBuses(), POLL_MS));
  }

  async #readNames() {
    for (const s of SOURCES.filter((x) => x.code < 32)) {
      const addr = `02${hex(s.code + 0x10)}00`;
      try {
        const f = await this.request(`RQH:${addr},000008;`, new RegExp(`^DTH:${addr},`));
        const bytes = f.split(',')[1] || '';
        let name = '';
        for (let k = 0; k + 1 < bytes.length; k += 2) name += String.fromCharCode(parseInt(bytes.slice(k, k + 2), 16));
        name = name.replace(/[\0\s]+$/, '').trim();
        if (name) this.names.set(s.id, name);
      } catch { /* an unanswered read is a label we do not get */ }
    }
    this.emit('state', {
      inputs: SOURCES.map(({ id, name, short }) => ({ id, name: this.names.get(id) || name, short })),
    });
  }

  #readBuses() {
    this.request('RQH:002100,000002;', /^DTH:002100,/).then((f) => this.#onFrame(f)).catch(() => {});
  }

  #onFrame(frame) {
    const inFlight = this.inFlight;
    if (inFlight && (inFlight.expect.test(frame) || /^ERR/.test(frame))) {
      clearTimeout(inFlight.timer);
      this.inFlight = null;
      if (/^ERR/.test(frame) && !inFlight.expect.test(frame)) inFlight.reject(new Error(`V-160HD ${frame}`));
      else inFlight.resolve(frame);
      this.timers.push(setTimeout(() => this.#pump(), GAP_MS));
      return; // the requester reads its own reply
    }
    const m = /^DTH:([0-9A-F]{6}),([0-9A-F]*)$/i.exec(frame);
    if (!m) return;
    const [, addr, data] = m;
    const bytes = [];
    for (let k = 0; k + 1 < data.length; k += 2) bytes.push(parseInt(data.slice(k, k + 2), 16));
    if (addr.toUpperCase() === '002100') {
      const patch = {};
      if (bytes.length >= 1) patch.program = bytes[0] + 1;
      if (bytes.length >= 2) patch.preview = bytes[1] + 1;
      this.emit('state', patch);
    } else if (addr.toUpperCase() === '0C0000' && bytes.length > 1) {
      const tally = {};
      bytes.forEach((b, code) => { if (b & 3) tally[code + 1] = { program: !!(b & 1), preview: !!(b & 2) }; });
      this.emit('state', { tally });
      this.#readBuses(); // tally is not the bus: re-read what is actually selected
    } else if (/^0C00[0-3][0-9A-F]$/i.test(addr) && bytes.length === 1) {
      /* A single-source tally notification, which some firmware may send. */
      this.#readBuses();
    }
  }

  #write(line) {
    this.socket?.write(`${line}\n`);
  }

  /** Queue a command; resolves with the matching reply frame. */
  request(line, expect = /^ACK$/) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.authed) { reject(new Error('not connected')); return; }
      this.queue.push({ line, expect, resolve, reject });
      if (!this.inFlight) this.#pump();
    });
  }

  #pump() {
    if (this.inFlight || !this.queue.length || !this.socket) return;
    const q = this.queue.shift();
    q.timer = setTimeout(() => {
      if (this.inFlight !== q) return;
      this.inFlight = null;
      q.reject(new Error(`no reply to ${q.line}`));
      this.#pump();
    }, REPLY_MS);
    this.inFlight = q;
    this.#write(q.line);
  }

  #plain() {
    return parseFloat(this.version || '0') >= 3.3;
  }

  async #press(addr) {
    await this.request(`DTH:${addr},01;`).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await this.request(`DTH:${addr},00;`).catch(() => {});
  }

  cut() { return this.#plain() ? this.request('CUT;') : this.#press('0B001E'); }
  auto() { return this.#plain() ? this.request('ATO;') : this.#press('0B001F'); }
  setPreview(id) { return this.request(`DTH:002101,${hex(Number(id) - 1)};`).then(() => this.#readBuses()); }
  setProgram(id) { return this.request(`DTH:002100,${hex(Number(id) - 1)};`).then(() => this.#readBuses()); }
}
