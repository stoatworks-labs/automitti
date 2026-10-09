/*
 * The wire to QLab: OSC over TCP 53000, SLIP-framed, kept up.
 *
 * TCP rather than UDP, for three reasons found on a real QLab 5.5.10:
 *   - over UDP, QLab sends its replies to port 53001, not back to the port the
 *     message came from, so a second client on the machine (Companion) fights
 *     for 53001;
 *   - over UDP, QLab forgets a client that has been quiet for 61 s, passcode
 *     and all;
 *   - /cueLists for a real show is bigger than a datagram.
 * Over TCP, replies and the pushed /update messages come back on the one
 * connection, and it stays connected until either side closes it.
 *
 * It knows nothing about workspaces: it parses what arrives into
 *   'reply'   { address, status, data, workspaceId }   from /reply/… (JSON)
 *   'update'  (address, args)                          from /update/…
 * and reconnects on its own until stopped.
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { encode, decode } from '../../../server/lib/osc.js';
import { slipEncode, SlipDecoder } from './slip.js';

export const QLAB_PORT = 53000;
const CONNECT_TIMEOUT_MS = 3000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 5000;

export class QLabLink extends EventEmitter {
  constructor({ host, port = QLAB_PORT, log = () => {} }) {
    super();
    this.host = host;
    this.port = port || QLAB_PORT;
    this.log = log;
    this.sock = null;
    this.open = false;
    this.stopped = true;
    this.retryMs = RETRY_MIN_MS;
    this.lastError = null;
    this.stats = { sent: 0, received: 0 };
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.sock?.destroy();
    this.sock = null;
    this.open = false;
  }

  /** One OSC message to QLab. False when there is no connection to send it on. */
  send(address, args = []) {
    if (!this.open || !this.sock) return false;
    this.sock.write(slipEncode(encode(address, args)));
    this.stats.sent += 1;
    return true;
  }

  #connect() {
    if (this.stopped) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => { if (!this.open) sock.destroy(new Error('no answer')); });
    const decoder = new SlipDecoder((frame) => this.#onFrame(frame));
    sock.on('connect', () => {
      sock.setTimeout(0);
      sock.setKeepAlive(true, 5000);
      this.open = true;
      this.lastError = null;
      this.retryMs = RETRY_MIN_MS;
      this.emit('open');
    });
    sock.on('data', (chunk) => decoder.push(chunk));
    sock.on('error', (err) => { this.lastError = err; });
    sock.on('close', () => {
      if (this.sock !== sock) return;
      const was = this.open;
      this.sock = null;
      this.open = false;
      this.emit('close', describe(this.lastError, this.host, this.port), was);
      if (this.stopped) return;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.#connect(), this.retryMs);
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    });
  }

  #onFrame(frame) {
    let messages;
    try {
      messages = decode(frame);
    } catch (err) {
      this.log(`QLab: bad OSC packet: ${err.message}`);
      return;
    }
    for (const m of messages) {
      this.stats.received += 1;
      if (m.address.startsWith('/reply/')) {
        let body;
        try { body = JSON.parse(m.args[0]); } catch { body = { status: 'error' }; }
        this.emit('reply', {
          /* The address QLab says it ran, which is not always the one sent:
             /cue/playhead/… comes back as /cue/<number>/…. */
          address: body.address || m.address.slice('/reply'.length),
          status: body.status,
          data: body.data,
          workspaceId: body.workspace_id ?? null,
        });
      } else if (m.address.startsWith('/update/')) {
        this.emit('update', m.address, m.args);
      }
    }
  }
}

function describe(err, host, port) {
  if (!err) return 'connection closed';
  if (err.code === 'ECONNREFUSED') return `nothing is listening on ${host}:${port} — is QLab running?`;
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return `${host} cannot be found`;
  if (err.message === 'no answer') return `${host}:${port} did not answer`;
  return err.message;
}
