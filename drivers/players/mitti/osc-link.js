/*
 * The OSC side of Mitti.
 *
 * Mitti takes commands on UDP 51000 and sends feedback to exactly ONE address.
 * automitti becomes that address: it folds the feedback into the playback
 * state, and re-sends every packet, byte for byte, to each enabled
 * destination — Companion, a Stream Deck plugin, a second show-control
 * machine. To a destination the feedback looks exactly as if it came from
 * Mitti, except for the source address.
 *
 * Liveness is Companion's scheme: `/mitti/ping` every 2 s, online while a
 * `/mitti/pong` has come back within the last 4 s.
 */

import dgram from 'node:dgram';
import os from 'node:os';
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { decode, encode } from '../../../server/lib/osc.js';

export const MITTI_OSC_PORT = 51000;
const PING_EVERY_MS = 2000;
const ONLINE_WITHIN_MS = 4500;

export class MittiOscLink extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => {host:string, port:number}} opts.target   where Mitti is
   * @param {number} opts.listenPort                         where Mitti sends feedback
   * @param {() => Array<{host:string, port:number, enabled:boolean}>} opts.destinations
   */
  constructor({ target, listenPort, destinations, bind = '0.0.0.0', log = () => {} }) {
    super();
    this.target = target;
    this.listenPort = listenPort;
    this.destinations = destinations;
    this.bind = bind;
    this.log = log;
    this.lastPong = 0;
    this.lastPacket = 0;
    this.online = false;
    this.stats = { received: 0, relayed: 0, relayErrors: 0, sent: 0 };
    this.sock = null;
    this.timer = null;
  }

  async start() {
    this.sock = dgram.createSocket({ type: 'udp4' });
    this.sock.on('message', (buf, rinfo) => this.#onPacket(buf, rinfo));
    this.sock.on('error', (err) => this.emit('error', err));
    await new Promise((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.bind(this.listenPort, this.bind, () => {
        this.sock.off('error', reject);
        resolve();
      });
    });
    this.listenPort = this.sock.address().port;
    this.timer = setInterval(() => this.#tick(), PING_EVERY_MS);
    this.#tick();
    this.emit('resend');
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.sock?.close(); } catch { /* already closed */ }
    this.sock = null;
  }

  /** Send a command to Mitti. */
  send(address, args = []) {
    const t = this.target();
    if (!this.sock || !t?.host) return false;
    this.sock.send(encode(address, args), t.port || MITTI_OSC_PORT, t.host);
    this.stats.sent += 1;
    return true;
  }

  #tick() {
    const host = this.target()?.host;
    if (host) {
      lookup(host, { family: 4 }).then(({ address }) => { this.targetIp = address; }, () => {});
    } else {
      this.targetIp = null;
    }
    this.send('/mitti/ping');
    const was = this.online;
    this.online = Date.now() - this.lastPong < ONLINE_WITHIN_MS;
    if (was !== this.online) {
      this.emit('online', this.online);
      if (this.online) this.emit('resend');
    }
  }

  #onPacket(buf, rinfo) {
    const t = this.target();
    const from = this.targetIp || t?.host;
    /* Feedback only from the configured Mitti. Anything else on this port is
       somebody else's traffic and must not reach the destinations. */
    if (from && !sameHost(rinfo.address, from)) return;
    this.stats.received += 1;
    this.lastPacket = Date.now();
    this.#relay(buf);
    let messages;
    try {
      messages = decode(buf);
    } catch (err) {
      this.log(`bad OSC from ${rinfo.address}: ${err.message}`);
      return;
    }
    for (const m of messages) {
      if (m.address === '/mitti/pong') {
        this.lastPong = Date.now();
        if (!this.online) {
          this.online = true;
          this.emit('online', true);
        }
      }
      this.emit('message', m);
    }
  }

  #relay(buf) {
    for (const d of this.destinations() || []) {
      if (!d.enabled || !d.host || !d.port) continue;
      if (d.port === this.listenPort && isSelf(d.host)) continue; // never loop back to ourselves
      this.sock.send(buf, d.port, d.host, (err) => {
        if (err) {
          this.stats.relayErrors += 1;
          this.emit('relayError', d, err);
        }
      });
      this.stats.relayed += 1;
    }
  }
}

const norm = (h) => String(h).replace(/^::ffff:/, '').toLowerCase();
const sameHost = (a, b) => {
  const x = norm(a); const y = norm(b);
  return x === y || (isSelf(x) && isSelf(y));
};
/* This machine, by any of its names: loopback or one of its own interface
   addresses. Mitti on the same Mac, told to send feedback to the LAN address it
   picked from its Bonjour list, sends FROM that address — not from 127.0.0.1 —
   and matching by string alone dropped every packet as a stranger's. */
const isSelf = (h) => {
  const x = norm(h);
  if (['127.0.0.1', 'localhost', '::1'].includes(x)) return true;
  return Object.values(os.networkInterfaces()).flat().some((a) => a && norm(a.address) === x);
};
