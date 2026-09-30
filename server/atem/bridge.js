/*
 * The emulated ATEM, wired to the real switcher.
 *
 * Mitti connects to it as to any ATEM. Its inputs are the real switcher's
 * inputs (same numbers, same names); its program, preview and tally follow
 * the real switcher; and what Mitti asks of it — CUT, AUTO, preview/program
 * selects, which is how Pause-at-End "cuts the ATEM" — is done on the real
 * switcher. The emulated state only ever changes when the real one reports.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import os from 'node:os';
import { AtemServer } from './server.js';

export class AtemBridge extends EventEmitter {
  constructor({ config, switcher, log = () => {} }) {
    super();
    this.config = config;
    this.switcher = switcher;
    this.log = log;
    this.server = null;
    this.error = null;
    /* The input count comes from the switcher driver (its descriptor's
       inputCount): topology to an ATEM client, so a change drops clients and
       they resync. */
    this.onSwitcher = () => { this.server?.setInputCount(this.switcher.inputCount()); this.#push(); };
  }

  async start() {
    this.switcher.on('change', this.onSwitcher);
    await this.#open();
  }

  stop() {
    this.server?.stop();
    this.server = null;
  }

  async reconfigure(prev) {
    const a = prev.atem; const b = this.config().atem;
    if (a.enabled !== b.enabled || a.port !== b.port || a.name !== b.name) {
      this.stop();
      await this.#open();
    }
    this.server?.setInputCount(this.switcher.inputCount());
    this.#push();
    this.emit('change');
  }

  async #open() {
    const c = this.config().atem;
    this.error = null;
    if (!c.enabled) { this.emit('change'); return; }
    const server = new AtemServer({
      port: c.port, name: c.name, inputCount: this.switcher.inputCount(), log: this.log,
    });
    server.on('command', (cmd) => this.#command(cmd));
    server.on('clients', () => this.emit('change'));
    server.on('error', (err) => { this.error = err.message; this.emit('change'); });
    try {
      await server.start();
      this.server = server;
      this.#push();
      this.log(`ATEM emulation on UDP ${server.port} as "${c.name}"`);
    } catch (err) {
      this.error = err.code === 'EADDRINUSE'
        ? `UDP ${c.port} is in use — is ATEM software or another emulator running here?`
        : err.message;
      this.log(`ATEM emulation: ${this.error}`);
    }
    this.emit('change');
  }

  #push() {
    if (!this.server) return;
    const m = this.switcher.snapshot();
    const online = m.status === 'online';
    this.server.setState({
      inputs: m.inputs,
      program: online ? m.program : null,
      preview: online ? m.preview : null,
      tally: online ? m.tally : {},
      inTransition: !!m.inTransition,
    });
  }

  async #command({ action, input, from }) {
    this.log(`ATEM: ${from} asked for ${action}${input != null ? ` ${input}` : ''}`);
    try {
      await this.switcher.command(action, input);
    } catch (err) {
      this.log(`ATEM: ${action} not done: ${err.message}`);
    }
  }

  /** Stable per machine and name, so Mitti remembers the same "device". */
  uniqueId() {
    return crypto.createHash('md5').update(`${os.hostname()}|${this.config().atem.name}`).digest('hex');
  }

  bonjourServices() {
    const c = this.config().atem;
    const txt = {
      txtvers: '1',
      name: 'automitti',
      'device name': c.name,
      class: 'AtemSwitcher',
      'unique id': this.uniqueId(),
      'protocol version': '2.32',
    };
    return [
      { key: 'atem-udp', name: c.name, type: 'switcher_ctrl', protocol: 'udp', port: c.port, txt },
      { key: 'atem-tcp', name: c.name, type: 'blackmagic', protocol: 'tcp', port: c.port, txt },
    ];
  }

  snapshot() {
    const c = this.config().atem;
    return {
      enabled: c.enabled,
      port: this.server?.port ?? c.port,
      error: this.error,
      clients: this.server ? this.server.list() : [],
      inputCount: this.server?.inputCount ?? null,
    };
  }
}
