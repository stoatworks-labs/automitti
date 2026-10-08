/*
 * Analog Way LiveCore (Ascender 16/32/48, NeXtage 08/16, SmartMatriX Ultra)
 * on the mnemonic protocol, TCP 10500 (server/lib/analogway.js). Everything
 * here is from openRCS, which drove a real NeXtage 16 with it.
 *
 * A screen has three fixed preset banks, PA/PB/PC — PRinp[screen, bank,
 * layer] — and a take does not copy one into another: it changes which bank
 * the screen shows. GCsta[group] says which:
 *
 *   0 AT_DOWN  PA on air      2 EFFECT_FROM_DOWN, 4 COPY FROM DOWN   leaving PA
 *   1 AT_UP    PB on air      3 EFFECT_FROM_UP,   5 COPY FROM UP     leaving PB
 *
 * GC* are indexed by group, and Plngr[screen] names a screen's group
 * (identity unless screens have been grouped).
 *
 * An input is ON AIR on a screen when it is the source of one of its layers
 * (SCmly[screen] of them) in the bank on air — and while a take is running,
 * in either bank, so a clip rolls as the mix starts. It is in PREVIEW when it
 * is a source in the other bank.
 *
 * Taking: the device's own GCtku/GCtkd leave a real NeXtage stuck in
 * EFFECT_FROM_* with the bar frozen, so a take is a sweep of the T-bar GCtba
 * (0 = PA, 65535 = PB) from the live end to the other, and a cut a jump
 * there. Selecting: a source written while CTpmu (preset-update mode) is 1 —
 * where the vendor's Web RCS keeps every unit — is held until GCupd, which
 * applies every pending change at once; this driver keeps CTpmu at 1 too.
 *
 * Polled on one socket, since the protocol does not provably push what this
 * needs: the take state every 100 ms, layer sources every 400 ms, the frame's
 * configuration every 5 s, the input labels once a connection.
 */

import { EventEmitter } from 'node:events';
import { AwLink, PORT } from '../../../server/lib/analogway.js';

export { PORT };
const SCREENS = 8;
const INPUTS = 24;
const BAR = 65535;
const FAST_MS = 100;
const SLOW_MS = 400;
const CONFIG_MS = 5000;
const SWEEP_STEP_MS = 45;

/* PDEV, as openRCS maps it. Only 97 has been seen on a real unit. */
const MODELS = { 96: 'NeXtage 08', 97: 'NeXtage 16', 98: 'Ascender 16', 99: 'Ascender 32', 100: 'Ascender 48', 101: 'SmartMatriX Ultra', 112: 'VIO 4K' };
const PLUGS = ['Analog', 'DVI-A', 'DVI-D', 'SDI', 'HDMI', 'DisplayPort'];

const onAirBank = (st) => ([1, 3, 5].includes(st) ? 1 : 0);
const input = (v) => (Number.isInteger(v) && v >= 1 && v <= INPUTS ? v : null);

export class LiveCoreDriver extends EventEmitter {
  constructor({ host, port = PORT, screens = [], layer = 1, takeMs = 1000, log = () => {} }) {
    super();
    this.wantScreens = screens.map((s) => Number(String(s).replace(/^S/i, '')) - 1).filter((n) => n >= 0 && n < SCREENS);
    this.layer = layer - 1;
    this.takeMs = takeMs;
    this.log = log;
    this.online = false;
    this.sweeps = new Map(); // group → interval
    this.link = new AwLink({ host, port, family: 'livecore', log });
    this.link.on('connected', () => this.#start());
    this.link.on('disconnected', (why) => this.#stop(this.wrongFamily || why));
    this.link.on('value', () => this.#changed());
    this.link.on('nak', (code) => { if ((this.naks = (this.naks || 0) + 1) <= 3) this.log(`LiveCore refused a command (E${code})`); });
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
    this.labels = null;
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
    for (const g of [...this.sweeps.keys()]) this.#stopSweep(g);
    if (why !== undefined || this.online) this.emit('status', 'offline', why);
    this.online = false;
  }

  /* ------------------------------------------------ reading */

  v(mnem, ...idx) { return this.link.value(mnem, idx); }

  /** The screens in scope: in service, and in the setting's list if it has one. */
  screens() {
    const all = Array.from({ length: SCREENS }, (_, s) => s).filter((s) => this.v('SCssh', s) > 0);
    return this.wantScreens.length ? all.filter((s) => this.wantScreens.includes(s)) : all;
  }

  layers(s) { return Array.from({ length: Math.max(0, Math.min(24, this.v('SCmly', s) || 0)) }, (_, l) => l); }

  group(s) { return this.v('Plngr', s) ?? s; }

  #config() {
    this.link.raw('?');
    this.link.raw('!');
    const asks = [['CTpmu', []]];
    for (let s = 0; s < SCREENS; s += 1) asks.push(['SCssh', [s]], ['SCmly', [s]], ['Plngr', [s]]);
    for (let i = 0; i < INPUTS; i += 1) asks.push(['INava', [i]], ['INplg', [i]]);
    this.link.ask(asks);
  }

  #fast() { this.link.ask([...new Set(this.screens().map((s) => this.group(s)))].map((g) => ['GCsta', [g]])); }

  #slow() {
    const asks = [];
    for (const s of this.screens()) for (const l of this.layers(s)) asks.push(['PRinp', [s, 0, l]], ['PRinp', [s, 1, l]]);
    this.link.ask(asks);
  }

  /** Each fitted input's label, read a character at a time on the plug it is using. */
  async #readLabels() {
    const labels = {};
    for (let i = 0; i < INPUTS; i += 1) {
      if (this.v('INava', i) !== 1) continue;
      const plug = this.v('INplg', i) ?? 0;
      const chars = await Promise.all(Array.from({ length: 16 }, (_, c) => this.link.get('LBInp', [i, plug, c])));
      const end = chars.findIndex((c) => !c);
      labels[i + 1] = { name: String.fromCharCode(...chars.slice(0, end < 0 ? 16 : end)).trim(), plug: PLUGS[plug] };
      if (!this.link.connected) return;
    }
    this.labels = labels;
    this.emit('state', { inputs: this.#inputs() });
  }

  #inputs() {
    const ids = Array.from({ length: INPUTS }, (_, i) => i + 1).filter((id) => this.v('INava', id - 1) === 1);
    return ids.map((id) => {
      const label = this.labels?.[id]?.name;
      return { id, name: label || `Input ${id}`, short: (label || `IN${id}`).slice(0, 4) };
    });
  }

  /**
   * Online once the first full read is in: the model, every screen's
   * service state, every input's presence, and for the screens in scope their
   * group, take state and every layer's source in both banks.
   */
  #ready() {
    if (this.v('PDEV') == null && this.v('DEV') == null) return false;
    if (this.v('CTpmu') == null) return false;
    for (let s = 0; s < SCREENS; s += 1) if (this.v('SCssh', s) == null) return false;
    for (let i = 0; i < INPUTS; i += 1) if (this.v('INava', i) == null) return false;
    for (const s of this.screens()) {
      if (this.v('SCmly', s) == null || this.v('GCsta', this.group(s)) == null) return false;
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
      if (dev != null && dev >= 256) {
        /* Let go: a Midra may take only one control session. */
        this.wrongFamily = 'this is a Midra (Pulse², Eikos², QuickVu…), not a LiveCore — choose “Analog Way Midra”';
        this.link.close();
        return;
      }
      if (!this.#ready()) return;
      this.online = true;
      const pdev = this.v('PDEV');
      this.emit('status', 'online');
      this.emit('state', { device: { model: MODELS[pdev] || `LiveCore${pdev != null ? ` (PDEV ${pdev})` : ''}` }, inputs: this.#inputs() });
      if (this.v('CTpmu') !== 1) {
        this.link.set('CTpmu', [], 1);
        this.log('LiveCore: preset-update mode on, as the Web RCS keeps it — source changes land with GROUP_UPDATE');
      }
      this.#readLabels().catch((err) => this.log(`LiveCore labels: ${err.message}`));
    }
    const tally = {};
    let program = null;
    let preview = null;
    let inTransition = false;
    const mark = (id, k) => { if (id != null) tally[id] = { ...(tally[id] || { program: false, preview: false }), [k]: true }; };
    for (const s of this.screens()) {
      const g = this.group(s);
      const st = this.v('GCsta', g);
      if (st == null) continue;
      const live = onAirBank(st);
      const moving = st >= 2 || this.sweeps.has(g);
      if (moving) inTransition = true;
      for (const l of this.layers(s)) {
        const a = input(this.v('PRinp', s, live, l));
        const b = input(this.v('PRinp', s, 1 - live, l));
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

  #groups() {
    const list = this.screens();
    if (!this.online) throw new Error('the LiveCore is not connected');
    if (!list.length) throw new Error('no screen in service');
    return [...new Set(list.map((s) => this.group(s)))];
  }

  #stopSweep(g) {
    clearInterval(this.sweeps.get(g));
    this.sweeps.delete(g);
  }

  /** Move the T-bar of group g to the end that is not on air: over `ms`, or at once. */
  #bar(g, ms) {
    this.#stopSweep(g);
    const live = onAirBank(this.v('GCsta', g));
    const from = live === 1 ? BAR : 0;
    const to = live === 1 ? 0 : BAR;
    if (!ms) { this.link.set('GCtba', [g], to); return; }
    const start = Date.now();
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / ms);
      try { this.link.set('GCtba', [g], Math.round(from + (to - from) * t)); } catch { this.#stopSweep(g); return; }
      if (t < 1) return;
      this.#stopSweep(g);
      /* A layer on an input with no card never lets a take land; finish it rather than leave it hanging. */
      setTimeout(() => {
        if ((this.v('GCsta', g) ?? 0) >= 2 && !this.sweeps.has(g) && this.link.connected) {
          this.log(`LiveCore: group ${g + 1} did not finish its take — forcing it`);
          this.link.set('GCtfr', [g], 1);
        }
      }, 1500);
    };
    this.sweeps.set(g, setInterval(tick, SWEEP_STEP_MS));
    tick();
    this.#changed();
  }

  async cut() { for (const g of this.#groups()) this.#bar(g, 0); }
  async auto() { for (const g of this.#groups()) this.#bar(g, this.takeMs); }

  /** Put an input on the chosen layer of the bank in preview (or on air), then apply it. */
  #source(id, which) {
    this.#groups();
    for (const s of this.screens()) {
      const live = onAirBank(this.v('GCsta', this.group(s)));
      const bank = which === 'program' ? live : 1 - live;
      const layers = this.layers(s);
      const l = layers.includes(this.layer) ? this.layer : layers[0];
      if (l == null) throw new Error(`screen ${s + 1} has no layer to put an input on`);
      this.link.set('PRinp', [s, bank, l], Number(id));
    }
    this.link.set('GCupd', [], 1);
    setTimeout(() => this.#slow(), 60);
  }

  async setPreview(id) { this.#source(id, 'preview'); }
  async setProgram(id) { this.#source(id, 'program'); }
}
