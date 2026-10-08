/*
 * Analog Way's mnemonic protocol: the Midra (Pulse², Eikos², QuickVu…) and
 * LiveCore (Ascender, NeXtage, SmartMatriX Ultra) families, ASCII over TCP
 * 10500. Not AWJ — the Midra 4K / Pulse 4K protocol shares nothing with it
 * but the company. Read from openRCS (stoatworks-labs/openrcs,
 * docs/PROTOCOL.md), which established it against a Pulse² and a NeXtage 16.
 *
 * Asymmetric framing — outbound the mnemonic is last, inbound first:
 *
 *   set     idx0,idx1,…,<value><MNEM><term>     0,1,1,5PRinp
 *   get     idx0,idx1,…,<MNEM><term>            0,1,1,PRinp
 *   reply   <MNEM>idx0,idx1,…,<value>           PRinp0,1,1,5
 *
 * The terminator is CRLF to a Midra and LF to a LiveCore; both answer in
 * CRLF. A rejected command is answered `E<code>` (E10 unknown, E12 wrong
 * number of indices) with nothing saying which command it was. `?` asks the
 * device type (`DEV<n>`), and `!` a LiveCore's product (`PDEV<n>`).
 *
 * The device pushes some changes unprompted, but not provably the ones a
 * switcher driver needs, so drivers poll — which also keeps a session that
 * has gone deaf (seen on a Pulse²) from looking alive.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

export const PORT = 10500;
export const TERMINATOR = { midra: '\r\n', livecore: '\n' };

/** One command line, without its terminator. `value` undefined is a get. */
export function encode(mnem, idx = [], value) {
  return `${idx.map((i) => `${i},`).join('')}${value ?? ''}${mnem}`;
}

/** One received line → `{ mnem, idx, value }`, `{ error }` for an E-code, or null. */
export function decode(line) {
  const m = /^([A-Za-z]+)(-?\d+(?:,-?\d+)*)?$/.exec(String(line).trim());
  if (!m) return null;
  const [, mnem, tail] = m;
  if (mnem === 'E' && tail && !tail.includes(',')) return { error: Number(tail) };
  const fields = tail ? tail.split(',').map(Number) : [];
  return { mnem, idx: fields.slice(0, -1), value: fields.length ? fields.at(-1) : null };
}

export const key = (mnem, idx = []) => `${mnem}:${idx.join(',')}`;

const RECONNECT_MS = 2000;
const QUIET_PROBE_MS = 5000;
const QUIET_DROP_MS = 15000;
const GET_TIMEOUT_MS = 1500;

/**
 * A kept-up session: reconnects, buffers lines, keeps every value it has
 * heard (pushed or asked for) in `values`, and drops a session that has
 * gone silent. Emits 'connected', 'disconnected' (reason), 'value'
 * (mnem, idx, value), 'nak' (code) and 'line' (raw).
 */
export class AwLink extends EventEmitter {
  constructor({ host, port = PORT, family = 'livecore', log = () => {} }) {
    super();
    this.host = host;
    this.port = port;
    this.term = TERMINATOR[family] || '\n';
    this.log = log;
    this.values = new Map();
    this.waiting = new Map(); // key → [resolve]
    this.socket = null;
    this.connected = false;
    this.closed = false;
    this.buf = '';
    this.heardAt = 0;
    this.watchdog = null;
  }

  connect() {
    if (this.closed || this.socket) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setNoDelay(true);
    sock.setEncoding('latin1');
    sock.on('connect', () => {
      this.connected = true;
      this.heardAt = Date.now();
      this.buf = '';
      this.watchdog = setInterval(() => this.#watch(), 1000);
      this.emit('connected');
    });
    sock.on('data', (chunk) => this.#data(chunk));
    sock.on('error', (err) => { this.lastError = err.message; });
    sock.on('close', () => {
      clearInterval(this.watchdog);
      this.watchdog = null;
      const was = this.connected;
      this.connected = false;
      this.socket = null;
      this.values.clear();
      for (const list of this.waiting.values()) for (const done of list) done(undefined);
      this.waiting.clear();
      this.emit('disconnected', this.lastError || (was ? 'connection closed' : 'no answer'));
      this.lastError = null;
      if (!this.closed) this.retry = setTimeout(() => this.connect(), RECONNECT_MS);
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
  }

  #watch() {
    const quiet = Date.now() - this.heardAt;
    if (quiet > QUIET_DROP_MS) {
      this.lastError = 'the switcher stopped answering';
      this.socket?.destroy();
    } else if (quiet > QUIET_PROBE_MS) {
      this.raw('?');
    }
  }

  #data(chunk) {
    this.heardAt = Date.now();
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line) this.#line(line);
    }
    if (this.buf.length > 65536) this.buf = '';
  }

  #line(line) {
    this.emit('line', line);
    const m = decode(line);
    if (!m) return;
    if ('error' in m) { this.emit('nak', m.error); return; }
    const k = key(m.mnem, m.idx);
    this.values.set(k, m.value);
    const list = this.waiting.get(k);
    if (list) {
      this.waiting.delete(k);
      for (const done of list) done(m.value);
    }
    this.emit('value', m.mnem, m.idx, m.value);
  }

  /** A line as it is, for `?` and `!`. */
  raw(text) {
    if (!this.connected) return false;
    this.socket.write(`${text}${this.term}`, 'latin1');
    return true;
  }

  /** Ask for values; the replies land in `values`. */
  ask(list) {
    if (!this.connected || !list.length) return;
    this.socket.write(list.map(([mnem, idx]) => `${encode(mnem, idx)}${this.term}`).join(''), 'latin1');
  }

  set(mnem, idx, value) {
    if (!this.connected) throw new Error('the switcher is not connected');
    this.socket.write(`${encode(mnem, idx, value)}${this.term}`, 'latin1');
  }

  /** Ask for one value and wait for its reply — undefined when none comes. */
  get(mnem, idx = [], timeout = GET_TIMEOUT_MS) {
    if (!this.connected) return Promise.resolve(undefined);
    const k = key(mnem, idx);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiting.get(k) || [];
        const i = list.indexOf(done);
        if (i >= 0) list.splice(i, 1);
        resolve(undefined);
      }, timeout);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      if (!this.waiting.has(k)) this.waiting.set(k, []);
      this.waiting.get(k).push(done);
      this.ask([[mnem, idx]]);
    });
  }

  value(mnem, idx = []) {
    return this.values.get(key(mnem, idx));
  }

  has(mnem, idx = []) {
    return this.values.has(key(mnem, idx));
  }
}
