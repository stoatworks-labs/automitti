/*
 * Mitti, from both of its talking surfaces:
 *
 *   OSC feedback   names, play state, playhead, elapsed/left of the current cue,
 *                  and the name of every cue (on a resend)
 *   HyperDeck      the clip list WITH DURATIONS — the only place the TRT of a
 *                  cue that is not current can be read — and transport
 *
 * Mitti sends its OSC feedback to exactly one address. This driver takes that
 * one slot and re-sends every packet to the relay destinations (osc-link.js).
 */

import { EventEmitter } from 'node:events';
import { MittiOscLink } from './osc-link.js';
import { DeckLink } from '../../../server/lib/hyperdeck/link.js';
import { applyFeedback, emptyPlayback, cueList, tcToSeconds } from './feedback.js';
import { frameRate, tcSeconds } from '../../../server/lib/hyperdeck/protocol.js';

const OSC_ACTIONS = {
  play: ['/mitti/play'],
  pause: ['/mitti/pause'],
  rewind: ['/mitti/rewind'],
  next: ['/mitti/jumpToNextCue'],
  prev: ['/mitti/jumpToPrevCue'],
  stoprewind: ['/mitti/pause', '/mitti/rewind'],
  stopnext: ['/mitti/pause', '/mitti/jumpToNextCue'],
};
const DECK_ACTIONS = {
  play: ['play'],
  pause: ['stop'],
  rewind: ['rewind'],
  next: ['next'],
  prev: ['prev'],
  stoprewind: ['stop', 'rewind'],
  stopnext: ['stop', 'next'],
};

export class MittiPlayer extends EventEmitter {
  /**
   * @param {{settings: {host, oscPort, feedbackPort, hyperdeck, hyperdeckPort, advertise},
   *          destinations: () => Array, log?: Function}} opts
   */
  constructor({ settings, destinations = () => [], log = () => {} }) {
    super();
    this.s = settings;
    this.log = log;
    this.playback = emptyPlayback();
    this.trtByName = new Map(); // learned from currentCueTRT as cues come up
    this.deck = null;
    this.error = null;
    this.osc = new MittiOscLink({
      target: () => ({ host: this.s.host, port: this.s.oscPort }),
      listenPort: this.s.feedbackPort,
      destinations,
      log,
    });
    this.osc.on('message', (m) => {
      if (applyFeedback(this.playback, m)) {
        this.playback.updatedAt = Date.now();
        if (m.address === '/mitti/currentCueTRT' && this.playback.current.name) {
          this.trtByName.set(this.playback.current.name, this.playback.current.trt);
        }
        this.emit('change', m.address);
      }
    });
    this.osc.on('resend', () => this.command('/mitti/resendOSCFeedback'));
    this.osc.on('online', (on) => { this.log(`Mitti OSC ${on ? 'online' : 'offline'}`); this.emit('change', 'online'); });
    this.osc.on('error', (err) => this.log(`OSC socket: ${err.message}`));
  }

  async start() {
    /* A taken feedback port must not take the whole app down with it: the page
       has to stay up to say so and to let the port be changed. */
    try {
      await this.osc.start();
    } catch (err) {
      this.osc.stop();
      this.error = err.code === 'EADDRINUSE'
        ? `UDP ${this.s.feedbackPort} is already in use — another device here, another automitti, or Companion on this machine?`
        : err.message;
      this.log(`Mitti feedback: ${this.error}`);
    }
    if (this.s.hyperdeck && this.s.host) {
      this.deck = new DeckLink({ id: 'mitti', name: 'Mitti', host: this.s.host, port: this.s.hyperdeckPort, profile: 'mitti', log: this.log });
      this.deck.on('change', () => this.emit('change', 'hyperdeck'));
      this.deck.on('error', () => {});
      this.deck.connect();
    }
  }

  stop() {
    this.osc.stop();
    this.deck?.close();
    this.deck = null;
  }

  /* ------------------------------------------------------------ commands */

  /** Any OSC message to Mitti. */
  command(address, args = []) {
    /* A resend re-lists every cue; forget the old list so a cue removed or
       reordered in Mitti does not linger under its old number. */
    if (address === '/mitti/resendOSCFeedback') this.playback.cues = {};
    return this.osc.send(address, args);
  }

  async act(action, { via = 'osc' } = {}) {
    if (via === 'hyperdeck' && this.deck?.status === 'connected') {
      for (const cmd of DECK_ACTIONS[action] || []) {
        const reply = await this.deck.send(cmd);
        if (reply?.code >= 100 && reply.code < 200) this.log(`HyperDeck ${cmd}: ${reply.text}`);
      }
      return;
    }
    for (const address of OSC_ACTIONS[action] || []) this.command(address);
  }

  bonjour() {
    if (!this.s.advertise) return [];
    const port = this.osc.listenPort || this.s.feedbackPort;
    return [{ key: 'osc', name: `automitti-${port}`, type: 'osc', protocol: 'udp', port }];
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
    const base = fromOsc.length ? fromOsc : clips.map((c) => ({ index: c.id, name: c.name }));
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
    const deck = this.deck?.describe();
    const online = this.osc.online;
    const summary = [
      this.s.host,
      `OSC ${online ? 'online' : 'offline'}`,
      this.deck ? `HyperDeck ${deck.status}${deck.error && deck.status !== 'connected' ? ` (${deck.error})` : ''}${deck.clips.length ? ` (${deck.clips.length} clips)` : ''}` : 'HyperDeck off',
    ].join(' · ');
    return {
      online,
      error: this.error,
      playing: p.playing,
      playhead: p.playhead,
      fps,
      updatedAt: p.updatedAt || null,
      current: {
        id: p.current.id,
        name: p.current.name,
        index: idx >= 0 ? cues[idx].index : null,
        trt: p.current.trt,
        trtSec: tcToSeconds(p.current.trt, fps) ?? (idx >= 0 ? cues[idx].seconds : null),
      },
      next: { name: p.next.name, index: next?.index ?? null, trtSec: next?.seconds ?? null },
      elapsed: p.elapsed,
      elapsedSec: tcToSeconds(p.elapsed, fps),
      remaining: p.remaining,
      remainingSec: tcToSeconds(p.remaining, fps),
      cues,
      summary,
      detail: {
        previous: p.previous.name,
        selected: p.selected,
        hyperdeck: deck ? { status: deck.status, error: deck.error, transport: deck.transport, clipCount: deck.clips.length } : null,
        relay: { ...this.osc.stats, listenPort: this.osc.listenPort },
      },
    };
  }
}
