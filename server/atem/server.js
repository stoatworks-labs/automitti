/*
 * An ATEM switcher, as Blackmagic's own Switcher SDK sees one: the server side
 * of the ATEM UDP protocol on port 9910.
 *
 * Mitti's ATEM integration is the SDK (IMTAtemListener loads the installed
 * BMDSwitcherAPI.bundle), so anything the SDK accepts, Mitti accepts. The
 * rules below were established against SDK 10.2.1 with its DeviceInfo sample
 * and a small SDK client — docs/ATEM.md has the evidence for each:
 *
 *  - Handshake: the client's SYN (payload 01…) is answered with a SYN echoing
 *    its session, payload `02 00 <id> 00 00 00 00`; from then on every packet
 *    MUST carry session 0x8000|id or the SDK ignores it.
 *  - The initial state dump must be COMPLETE and EXACT: `_top` announces the
 *    capabilities, and the SDK fails the connection on a missing atom, an
 *    extra capability atom, a count that disagrees with `_top`, or a known atom
 *    at the wrong size. The minimal accepted set is what `dump()` sends: one
 *    M/E, no keyers, no multiviewer, one still in the media pool (zero fails).
 *  - `_ver` 2.32 with a non-ISO model byte (0x0d, ATEM Mini): the SDK wants
 *    major 2 and minor ≥ 2.30, no upper bound; ISO models need more atoms.
 *  - Per-input tally callbacks — what Mitti plays on — are driven by `TlSr`
 *    only. `TlIn` is sent too, for other clients.
 *  - Mitti's "cut/auto to input" is `CPvI` then `DCut`/`DAut` on M/E 1.
 *
 * The switcher behind it is abstract: `setState()` feeds it inputs,
 * program, preview and tally; `command` events carry what a client asked for.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

export const ATEM_PORT = 9910;

const F = { REL: 0x01, SYN: 0x02, RETX: 0x04, REQ: 0x08, ACK: 0x10 };
const MAX_PAYLOAD = 1400;
const RESEND_MS = 100;
const DROP_AFTER_MS = 5000;
const PING_MS = 500;
const PROGRAM_ID = 10010;
const PREVIEW_ID = 10011;

/* ---------------------------------------------------------------- atoms */

function atom(name, body) {
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt16BE(8 + body.length, 0);
  b.write(name, 4, 4, 'latin1');
  Buffer.from(body).copy(b, 8);
  return b;
}

const fixed = (s, n) => {
  const out = Buffer.alloc(n);
  Buffer.from(String(s ?? ''), 'latin1').copy(out, 0, 0, n);
  return out;
};

/** ASCII-safe: the SDK takes Latin-1 bytes; anything outside becomes '?'. */
const ascii = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');

function inPr(src) {
  const b = Buffer.alloc(36);
  b.writeUInt16BE(src.id, 0);
  fixed(ascii(src.name).slice(0, 20), 20).copy(b, 2);
  fixed(ascii(src.short).slice(0, 4), 4).copy(b, 22);
  b[26] = 1; // names are defaults
  if (src.kind === 'external') {
    b.writeUInt16BE(0x0002, 28); // HDMI available
    b.writeUInt16BE(0x0002, 30); // HDMI current
    b[32] = 0;
    b[34] = 0x1f;
    b[35] = 0x01;
  } else if (src.kind === 'black') {
    b.writeUInt16BE(0x0100, 28);
    b.writeUInt16BE(0x0100, 30);
    b[32] = 1;
    b[34] = 0x1f;
    b[35] = 0x01;
  } else {
    b.writeUInt16BE(0x0100, 28);
    b.writeUInt16BE(0x0100, 30);
    b[32] = 0x80; // M/E output
  }
  return atom('InPr', b);
}

const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

export class AtemServer extends EventEmitter {
  /**
   * @param {{port?:number, bind?:string, name?:string, inputCount:number, log?:Function}} opts
   */
  constructor({ port = ATEM_PORT, bind = '0.0.0.0', name = 'automitti', inputCount = 8, log = () => {} }) {
    super();
    this.port = port;
    this.bind = bind;
    this.name = name;
    this.log = log;
    this.clients = new Map(); // "ip:port" → client
    this.nextId = 1;
    this.sock = null;
    this.timer = null;
    this.state = { inputs: [], program: null, preview: null, tally: {}, inTransition: false };
    this.setInputCount(inputCount);
  }

  /** The number of external inputs is topology: changing it drops every client so they resync. */
  setInputCount(n) {
    const count = Math.max(1, Math.min(200, n | 0));
    if (count === this.inputCount) return;
    this.inputCount = count;
    for (const c of this.clients.values()) this.#drop(c, 'topology changed');
  }

  sources() {
    const names = new Map(this.state.inputs.map((i) => [i.id, i]));
    const ext = Array.from({ length: this.inputCount }, (_, k) => {
      const i = names.get(k + 1);
      return { id: k + 1, kind: 'external', name: i?.name || `Input ${k + 1}`, short: i?.short || `IN${k + 1}` };
    });
    return [
      { id: 0, kind: 'black', name: 'Black', short: 'BLK' },
      ...ext,
      { id: PROGRAM_ID, kind: 'me', name: 'Program', short: 'PGM' },
      { id: PREVIEW_ID, kind: 'me', name: 'Preview', short: 'PVW' },
    ];
  }

  async start() {
    this.sock = dgram.createSocket({ type: 'udp4' });
    this.sock.on('message', (buf, rinfo) => this.#onPacket(buf, rinfo));
    this.sock.on('error', (err) => this.emit('error', err));
    await new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(this.port, this.bind, () => { this.sock.off('error', reject); resolve(); });
    });
    this.port = this.sock.address().port;
    this.timer = setInterval(() => this.#tick(), 50);
  }

  stop() {
    clearInterval(this.timer);
    for (const c of this.clients.values()) this.#drop(c, 'server stopped');
    try { this.sock?.close(); } catch { /* closed */ }
    this.sock = null;
  }

  /* ------------------------------------------------------------ state */

  /** Feed the real switcher's state. Sends only what changed. */
  setState(next) {
    const prev = this.state;
    this.state = { ...prev, ...next };
    const namesChanged = JSON.stringify(prev.inputs) !== JSON.stringify(this.state.inputs);
    const parts = [];
    if (namesChanged) for (const s of this.sources()) if (s.kind === 'external') parts.push(inPr(s));
    parts.push(...this.#stateAtoms());
    this.#broadcast(Buffer.concat(parts));
  }

  #pgm() { return this.#valid(this.state.program) ? this.state.program : 0; }
  #pvw() { return this.#valid(this.state.preview) ? this.state.preview : 0; }
  #valid(id) { return Number.isInteger(id) && id >= 1 && id <= this.inputCount; }

  #flags(id) {
    const t = this.state.tally?.[id];
    let f = 0;
    if (t) f = (t.program ? 1 : 0) | (t.preview ? 2 : 0);
    else f = (id === this.#pgm() && id !== 0 ? 1 : 0) | (id === this.#pvw() && id !== 0 ? 2 : 0);
    return f;
  }

  #stateAtoms() {
    const prgI = Buffer.alloc(4); prgI.writeUInt16BE(this.#pgm(), 2);
    const prvI = Buffer.alloc(8); prvI.writeUInt16BE(this.#pvw(), 2);
    const trPs = Buffer.alloc(8);
    trPs[1] = this.state.inTransition ? 1 : 0;
    trPs[2] = 25;
    trPs.writeUInt16BE(this.state.inTransition ? 5000 : 0, 4);
    const srcs = this.sources();
    const ext = srcs.filter((s) => s.kind === 'external');
    const tlIn = Buffer.alloc(2 + ext.length);
    tlIn.writeUInt16BE(ext.length, 0);
    ext.forEach((s, k) => { tlIn[2 + k] = this.#flags(s.id); });
    const tlSr = Buffer.alloc(2 + 3 * srcs.length);
    tlSr.writeUInt16BE(srcs.length, 0);
    srcs.forEach((s, k) => {
      tlSr.writeUInt16BE(s.id, 2 + 3 * k);
      tlSr[4 + 3 * k] = s.kind === 'external' ? this.#flags(s.id) : 0;
    });
    return [atom('PrgI', prgI), atom('PrvI', prvI), atom('TrPs', trPs), atom('TlIn', pad4(tlIn)), atom('TlSr', pad4(tlSr))];
  }

  /** The initial state dump: the minimal set SDK 10.2.1 accepts (docs/ATEM.md §3.4), at protocol 2.32. */
  dump() {
    const srcs = this.sources();
    const pin = Buffer.alloc(44);
    fixed(ascii(this.name).slice(0, 39), 40).copy(pin, 0);
    pin[40] = 0x0d; // ATEM Mini: non-ISO, minimum protocol 2.30
    const top = Buffer.alloc(28);
    top[0] = 1;              // one M/E
    top[1] = srcs.length;    // must equal the number of InPr
    const vmc = Buffer.from('00010000' + '1a000000' + '04000000' + '000000000000', 'hex');
    return [
      atom('_ver', Buffer.from([0, 2, 0, 32])),
      atom('_pin', pin),
      atom('_top', top),
      atom('_MeC', Buffer.alloc(4)),
      atom('_MAC', Buffer.alloc(4)),
      atom('_VMC', vmc),
      atom('Powr', Buffer.from([1, 0, 0, 0])),
      atom('VidM', Buffer.from([0x1a, 0, 0, 0])),
      ...srcs.map(inPr),
      atom('TrSS', Buffer.from([0, 0, 1, 0, 1, 0, 0, 0])),
      atom('TrPr', Buffer.alloc(4)),
      atom('TMxP', Buffer.from([0, 25, 0, 0])),
      atom('MRPr', Buffer.from([0, 0, 0xff, 0xff])),
      atom('MRcS', Buffer.from([0, 0, 0xff, 0xff])),
      ...this.#stateAtoms(),
      atom('_mpl', Buffer.from([1, 0, 0, 0])),
      atom('LKST', Buffer.from([0, 0, 0, 0x50])),
      atom('MPfe', Buffer.alloc(24)),
      atom('InCm', Buffer.from([1, 0, 0, 0])),
    ];
  }

  /* ------------------------------------------------------------ transport */

  #header(flags, length, session, { ack = 0, remote = 0, pid = 0 } = {}) {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(((flags & 0x1f) << 11) | (length & 0x07ff), 0);
    h.writeUInt16BE(session, 2);
    h.writeUInt16BE(ack, 4);
    h.writeUInt16BE(remote, 8);
    h.writeUInt16BE(pid, 10);
    return h;
  }

  #send(c, buf) { this.sock?.send(buf, c.port, c.address); }

  #reliable(c, payload) {
    c.pid = (c.pid + 1) & 0x7fff;
    const pkt = Buffer.concat([this.#header(F.REL, 12 + payload.length, c.session, { pid: c.pid }), payload]);
    c.unacked.set(c.pid, { pkt, sentAt: Date.now(), tries: 0 });
    this.#send(c, pkt);
  }

  /** Split atoms into ≤1400-byte payloads and send each reliably. */
  #sendAtoms(c, atoms) {
    let cur = [];
    let size = 0;
    for (const a of atoms) {
      if (size + a.length > MAX_PAYLOAD && cur.length) { this.#reliable(c, Buffer.concat(cur)); cur = []; size = 0; }
      cur.push(a); size += a.length;
    }
    if (cur.length) this.#reliable(c, Buffer.concat(cur));
  }

  #broadcast(payload) {
    if (!payload.length) return;
    for (const c of this.clients.values()) {
      if (!c.ready) continue;
      const atoms = [];
      for (let o = 0; o + 8 <= payload.length;) { const n = payload.readUInt16BE(o); if (n < 8) break; atoms.push(payload.subarray(o, o + n)); o += n; }
      this.#sendAtoms(c, atoms);
    }
  }

  #onPacket(buf, rinfo) {
    if (buf.length < 12) return;
    const flags = buf[0] >> 3;
    const session = buf.readUInt16BE(2);
    const ackId = buf.readUInt16BE(4);
    const key = `${rinfo.address}:${rinfo.port}`;
    let c = this.clients.get(key);

    if (flags & F.SYN) {
      const code = buf.length >= 13 ? buf[12] : 0;
      if (code === 0x04) { if (c) this.#drop(c, 'client closed'); return; }
      if (code !== 0x01) return;
      if (c) this.#drop(c, 'client reconnected');
      const id = this.nextId;
      this.nextId = (this.nextId % 0x7ffe) + 1;
      c = {
        key, address: rinfo.address, port: rinfo.port, id, session: 0x8000 | id, synSession: session,
        pid: 0, lastIn: 0, unacked: new Map(), ready: false, dumped: false, lastSeen: Date.now(), lastPing: Date.now(),
      };
      this.clients.set(key, c);
      const reply = Buffer.concat([
        this.#header(F.SYN, 20, session, { remote: buf.readUInt16BE(8) }),
        Buffer.from([0x02, 0x00, (id >> 8) & 0xff, id & 0xff, 0, 0, 0, 0]),
      ]);
      this.#send(c, reply);
      this.log(`ATEM: ${rinfo.address} connecting (session ${c.session.toString(16)})`);
      return;
    }
    if (!c) return;
    c.lastSeen = Date.now();

    /* The client's ACK of our SYN (old session) starts the dump. */
    if (!c.dumped && (flags & F.ACK)) {
      c.dumped = true;
      this.#sendAtoms(c, this.dump());
      c.ready = true;
      this.emit('clients');
      this.log(`ATEM: ${rinfo.address} connected`);
    }

    if (flags & F.ACK) {
      /* Cumulative: everything up to ackId (mod 0x8000) is delivered. */
      for (const pid of [...c.unacked.keys()]) {
        if (((ackId - pid) & 0x7fff) < 0x4000) c.unacked.delete(pid);
      }
    }
    if (flags & F.REQ) {
      const from = buf.readUInt16BE(6) & 0x7fff;
      for (const [pid, u] of c.unacked) if (((pid - from) & 0x7fff) < 0x4000) this.#resend(c, u);
    }
    if (flags & F.REL) {
      const pid = buf.readUInt16BE(10);
      this.#send(c, this.#header(F.ACK, 12, c.session, { ack: pid }));
      const fresh = ((pid - c.lastIn) & 0x7fff) > 0 && ((pid - c.lastIn) & 0x7fff) < 0x4000;
      if (!fresh && c.lastIn !== 0) return; // a duplicate: re-ACKed, not re-run
      c.lastIn = pid;
      this.#commands(c, buf.subarray(12, Math.min(buf.length, buf.readUInt16BE(0) & 0x07ff)));
    }
  }

  #commands(c, payload) {
    for (let o = 0; o + 8 <= payload.length;) {
      const n = payload.readUInt16BE(o);
      if (n < 8 || o + n > payload.length) break;
      const name = payload.toString('latin1', o + 4, o + 8);
      const body = payload.subarray(o + 8, o + n);
      o += n;
      const me = body[0] ?? 0;
      if (me !== 0 && ['CPgI', 'CPvI', 'DCut', 'DAut'].includes(name)) continue; // only M/E 1 exists
      switch (name) {
        case 'CPvI': this.emit('command', { action: 'preview', input: body.readUInt16BE(2), from: c.address }); break;
        case 'CPgI': this.emit('command', { action: 'program', input: body.readUInt16BE(2), from: c.address }); break;
        case 'DCut': this.emit('command', { action: 'cut', from: c.address }); break;
        case 'DAut': this.emit('command', { action: 'auto', from: c.address }); break;
        default: this.emit('unknown', { name, from: c.address }); break;
      }
    }
  }

  #resend(c, u) {
    const pkt = Buffer.from(u.pkt);
    pkt[0] |= F.RETX << 3;
    u.sentAt = Date.now();
    u.tries += 1;
    this.#send(c, pkt);
  }

  #tick() {
    const now = Date.now();
    for (const c of [...this.clients.values()]) {
      if (now - c.lastSeen > DROP_AFTER_MS) { this.#drop(c, 'timed out'); continue; }
      for (const u of c.unacked.values()) if (now - u.sentAt > RESEND_MS) this.#resend(c, u);
      if (c.ready && now - c.lastPing > PING_MS) {
        c.lastPing = now;
        this.#reliable(c, Buffer.alloc(0));
      }
    }
  }

  #drop(c, why) {
    if (!this.clients.has(c.key)) return;
    this.clients.delete(c.key);
    if (this.sock && why !== 'client closed' && why !== 'timed out') {
      /* Tell it to go: the SDK's own close is a SYN with payload 04. */
      this.#send(c, Buffer.concat([this.#header(F.SYN, 20, c.session), Buffer.from([4, 0, 0, 0, 0, 0, 0, 0])]));
    }
    this.log(`ATEM: ${c.address} disconnected (${why})`);
    this.emit('clients');
  }

  list() {
    return [...this.clients.values()].filter((c) => c.ready).map((c) => ({ address: c.address, port: c.port }));
  }
}
