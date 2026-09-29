/*
 * Mitti's own ATEM/NDI behaviour, run from automitti's side over OSC or
 * HyperDeck — for when Mitti is driven directly instead of watching an
 * emulated ATEM or its NDI tally:
 *
 *   on program   play, or nothing
 *   on preview   rewind to the top of the cue, or nothing
 *   taken off    nothing, pause, stop and rewind, stop and load the next cue
 *   cue ends     cut, auto, or nothing — optionally `lead` seconds early
 *
 * The same four choices Mitti offers for an ATEM (and LivePremier Plus's
 * HyperDeck rules, which this mirrors). Off by default: a rule set switched
 * on by accident rolls a clip the next time its input is cut to.
 *
 * Do not use it at the same time as Mitti's own ATEM or NDI trigger pointed
 * at automitti — both would act on every take.
 */

import { EventEmitter } from 'node:events';

export class Rules extends EventEmitter {
  constructor({ config, switcher, mitti, log = () => {} }) {
    super();
    this.config = config;
    this.switcher = switcher;
    this.mitti = mitti;
    this.log = log;
    this.was = { program: false, preview: false };
    this.endFiredFor = null;
    this.last = null;
  }

  start() {
    this.switcher.on('tally', () => this.#onTally());
    this.mitti.on('change', () => this.#onPlayback());
  }

  #enabled() {
    const r = this.config().rules;
    return r.enabled && this.switcher.mittiInput() != null;
  }

  #did(what) {
    this.last = { what, at: Date.now() };
    this.log(`rule: ${what}`);
    this.emit('change');
  }

  #onTally() {
    const id = this.switcher.mittiInput();
    const now = id == null ? { program: false, preview: false } : this.switcher.tallyOf(id);
    const was = this.was;
    this.was = now;
    if (!this.#enabled()) return;
    const r = this.config().rules;
    if (now.program && !was.program) {
      this.endFiredFor = null;
      this.sawRunning = false;
      if (r.onProgram === 'play') { this.mitti.act('play', r.via); this.#did('on program → play'); }
    } else if (!now.program && was.program) {
      const map = { pause: 'pause', rewind: 'stoprewind', next: 'stopnext' };
      if (map[r.onLeave]) { this.mitti.act(map[r.onLeave], r.via); this.#did(`taken off → ${r.onLeave}`); }
    } else if (now.preview && !was.preview && !now.program) {
      if (r.onPreview === 'rewind') { this.mitti.act('rewind', r.via); this.#did('on preview → rewind'); }
    }
  }

  #onPlayback() {
    if (!this.#enabled()) return;
    const r = this.config().rules;
    if (r.onEnd === 'none' || !this.was.program) return;
    const s = this.mitti.snapshot();
    if (s.playing) this.playingAt = Date.now();
    /* A cue parked on its last frame is not a cue ending — only one that was
       running a moment ago is. */
    if (!s.playing && Date.now() - (this.playingAt || 0) > 2000) return;
    const key = `${s.current.index ?? s.current.name}`;
    if (key !== this.runKey) { this.runKey = key; this.sawRunning = false; }
    if (this.endFiredFor === key) return;
    const left = s.remainingSec;
    if (left == null) return;
    /* Only a cue seen running with time still on it can END — not one pressed
       play on while parked at its last frame. */
    if (s.playing && left > r.lead + 0.5) this.sawRunning = true;
    if (!this.sawRunning) return;
    const atEnd = r.lead > 0 ? s.playing && left <= r.lead : left <= 1 / (s.fps || 25) + 0.05;
    if (!atEnd) return;
    this.endFiredFor = key;
    this.switcher.command(r.onEnd).then(
      () => this.#did(`cue ended → ${r.onEnd}`),
      (err) => this.log(`rule: cue ended → ${r.onEnd} failed: ${err.message}`),
    );
  }

  snapshot() {
    return { active: this.#enabled(), tally: this.was, last: this.last };
  }
}
