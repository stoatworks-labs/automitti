/*
 * Everything automitti knows about Mitti, from both of Mitti's talking
 * surfaces:
 *
 *   OSC feedback   names, play state, playhead, elapsed/left of the current cue,
 *                  and the name of every cue (on a resend)
 *   HyperDeck      the clip list WITH DURATIONS — the only place the TRT of a
 *                  cue that is not current can be read — and transport
 *
 * The display page, the rules and the NDI/ATEM tally all read `snapshot()`.
 */

import { EventEmitter } from 'node:events';
import { MittiOscLink } from './oscLink.js';
import { DeckLink } from './hyperdeck/link.js';
import { applyFeedback, emptyPlayback, cueList, tcToSeconds } from './feedback.js';
import { frameRate, tcSeconds } from './hyperdeck/protocol.js';

export class Mitti extends EventEmitter {
  constructor({ config, log = () => {} }) {
    super();
    this.config = config; // () => current config
    this.log = log;
    this.playback = emptyPlayback();
    this.trtByName = new Map(); // learned from currentCueTRT as cues come up
    this.deck = null;
    this.osc = new MittiOscLink({
      target: () => ({ host: this.config().mitti.host, port: this.config().mitti.oscPort }),
      listenPort: this.config().mitti.feedbackPort,
      destinations: () => this.config().destinations,
      log,
    });
    this.osc.on('message', (m) => {
      if (applyFeedback(this.playback, m)) {
        this.playback.updatedAt = Date.now();
        if (m.address === '/mitti/currentCueTRT' && this.playback.current.name) {
          this.trtByName.set(this.playback.current.name, this.playback.current.trt);
        }
        this.#changed(m.address);
      }
    });
    this.osc.on('online', (on) => { this.log(`Mitti OSC ${on ? 'online' : 'offline'}`); this.#changed('online'); });
    this.osc.on('error', (err) => this.log(`OSC socket: ${err.message}`));
  }

  async start() {
    await this.#listen();
    this.#startDeck();
  }

  /* A taken feedback port must not take the whole app down with it: the page
     has to stay up to say so and to let the port be changed. */
  async #listen() {
    try {
      await this.osc.start();
      this.error = null;
    } catch (err) {
      this.osc.stop();
      this.error = err.code === 'EADDRINUSE'
        ? `UDP ${this.config().mitti.feedbackPort} is already in use — another automitti, or Companion on this machine?`
        : err.message;
      this.log(`Mitti feedback: ${this.error}`);
    }
  }

  stop() {
    this.osc.stop();
    this.deck?.close();
    this.deck = null;
  }

  /** Called after a settings change. Rebinds only what changed. */
  async reconfigure(prev) {
    const c = this.config().mitti;
    if (prev.mitti.feedbackPort !== c.feedbackPort) {
      this.osc.stop();
      this.osc.listenPort = c.feedbackPort;
      await this.#listen();
    }
    if (prev.mitti.host !== c.host || prev.mitti.hyperdeck !== c.hyperdeck || prev.mitti.hyperdeckPort !== c.hyperdeckPort) {
      this.deck?.close();
      this.deck = null;
      this.playback = emptyPlayback();
      this.#startDeck();
      this.osc.send('/mitti/resendOSCFeedback');
    }
    this.#changed('config');
  }

  #startDeck() {
    const c = this.config().mitti;
    if (!c.hyperdeck || !c.host) return;
    this.deck = new DeckLink({ id: 'mitti', name: 'Mitti', host: c.host, port: c.hyperdeckPort, profile: 'mitti', log: this.log });
    this.deck.on('change', () => this.#changed('hyperdeck'));
    this.deck.on('error', () => {});
    this.deck.connect();
  }

  #changed(why) {
    this.emit('change', why);
  }

  /* ------------------------------------------------------------ commands */

  send(address, args) { return this.osc.send(address, args); }

  /** One transport action, over OSC or HyperDeck. */
  async act(action, via = 'osc') {
    if (via === 'hyperdeck' && this.deck?.status === 'connected') {
      const map = { play: 'play', pause: 'stop', rewind: 'rewind', next: 'next', prev: 'prev' };
      if (action === 'stoprewind') { await this.deck.send('stop').catch(() => {}); return this.deck.send('rewind').catch(() => {}); }
      if (action === 'stopnext') { await this.deck.send('stop').catch(() => {}); return this.deck.send('next').catch(() => {}); }
      if (map[action]) return this.deck.send(map[action]).catch((e) => this.log(`HyperDeck ${action}: ${e.message}`));
    }
    const osc = {
      play: '/mitti/play',
      pause: '/mitti/pause',
      rewind: '/mitti/rewind',
      next: '/mitti/jumpToNextCue',
      prev: '/mitti/jumpToPrevCue',
    };
    if (action === 'stoprewind') { this.send('/mitti/pause'); return this.send('/mitti/rewind'); }
    if (action === 'stopnext') { this.send('/mitti/pause'); return this.send('/mitti/jumpToNextCue'); }
    if (osc[action]) return this.send(osc[action]);
    return false;
  }

  /* ------------------------------------------------------------ reading */

  fps() {
    const deckRate = frameRate(this.deck?.transport?.videoFormat);
    /* The deck's video format is authoritative; the highest frame number seen
       in a timecode string is a guess that is too low until it has seen one near
       the top of a second. */
    return (deckRate ? Math.round(deckRate) : null) || (this.playback.maxFrame >= 20 ? this.playback.fps : 25);
  }

  /** The playlist: OSC names, with HyperDeck durations laid alongside. */
  cues() {
    const fps = this.fps();
    const clips = this.deck?.clips || [];
    const deckRate = frameRate(this.deck?.transport?.videoFormat) || fps;
    const fromOsc = cueList(this.playback);
    const base = fromOsc.length
      ? fromOsc
      : clips.map((c) => ({ index: c.id, name: c.name }));
    return base.map((c) => {
      const clip = clips.find((k) => k.id === c.index) || clips.find((k) => k.name === c.name);
      let seconds = clip ? tcSeconds(clip.duration, deckRate) : null;
      if (seconds == null && this.trtByName.has(c.name)) seconds = tcToSeconds(this.trtByName.get(c.name), fps);
      return { index: c.index, name: c.name, seconds };
    });
  }

  snapshot() {
    const p = this.playback;
    const fps = this.fps();
    const cues = this.cues();
    const idx = cues.findIndex((c) => c.name === p.current.name);
    const find = (name, near) => {
      if (!name) return null;
      if (near >= 0 && cues[near]?.name === name) return cues[near];
      return cues.find((c) => c.name === name) || null;
    };
    const next = find(p.next.name, idx >= 0 ? idx + 1 : -1);
    const trtSec = tcToSeconds(p.current.trt, fps) ?? (idx >= 0 ? cues[idx].seconds : null);
    const deck = this.deck?.describe();
    return {
      at: Date.now(),
      online: this.osc.online,
      error: this.error || null,
      host: this.config().mitti.host,
      hyperdeck: deck ? { status: deck.status, error: deck.error, transport: deck.transport, clipCount: deck.clips.length } : null,
      playing: p.playing,
      playhead: p.playhead,
      fps,
      current: {
        id: p.current.id,
        name: p.current.name,
        index: idx >= 0 ? cues[idx].index : null,
        trt: p.current.trt,
        trtSec,
      },
      elapsed: p.elapsed,
      elapsedSec: tcToSeconds(p.elapsed, fps),
      remaining: p.remaining,
      remainingSec: tcToSeconds(p.remaining, fps),
      updatedAt: p.updatedAt || null,
      next: { name: p.next.name, index: next?.index ?? null, trtSec: next?.seconds ?? null },
      previous: { name: p.previous.name },
      selected: { id: p.selected.id, name: p.selected.name },
      cues,
      stats: this.osc.stats,
      feedbackPort: this.osc.listenPort,
    };
  }
}
