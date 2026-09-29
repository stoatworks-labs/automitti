#!/usr/bin/env node
/*
 * A Mitti on this machine: its OSC commands and feedback, and its HyperDeck
 * emulation, over one playlist that plays in real time.
 *
 *   node tools/mitti-sim.mjs --feedback 127.0.0.1:51010
 *   … --osc 51000 --hyperdeck 9993 --host 127.0.0.1
 *
 * What automitti's tests run against and what to point it at without Mitti.
 * The vocabulary is the one read out of Mitti 2.8.18's binary (docs/MITTI.md);
 * the timing (feedback every 100 ms while playing) is a guess, not a
 * measurement. It is an emulation, not proof that Mitti agrees.
 *
 * Loopback by default: a fake Mitti on the show network is one a real
 * Companion could find.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '../server/mitti/osc.js';

const FPS = 25;
const FORMAT = '1080p25';

export const tc = (seconds, fps = FPS) => {
  const total = Math.max(0, Math.round(seconds * fps));
  const f = total % fps;
  const s = Math.floor(total / fps);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
};

export const DEFAULT_CUES = [
  { name: 'Walk-in loop', seconds: 30, id: 'WALK', pauseAtEnd: false, loop: true },
  { name: 'Opener', seconds: 12, id: 'OPEN', pauseAtEnd: true },
  { name: 'Sponsor reel', seconds: 20, id: 'SPON', pauseAtEnd: true },
  { name: 'Award VT 1', seconds: 45, id: 'AW1', pauseAtEnd: true },
  { name: 'Playout', seconds: 90, id: 'OUT', pauseAtEnd: true },
];

/**
 * @param {{oscPort?:number, hyperdeckPort?:number|false, host?:string,
 *          feedback?:{host:string, port:number}, cues?:Array, tickMs?:number}} options
 */
export async function startMittiSim(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const state = {
    cues: (options.cues || DEFAULT_CUES).map((c) => ({ pauseAtEnd: true, loop: false, ...c })),
    current: 0,      // index into cues
    selected: 1,
    at: 0,           // seconds into the current cue
    playing: false,
    feedback: options.feedback || null,
    received: [],    // every OSC message, for tests
  };
  const cue = () => state.cues[state.current];

  /* ---------------------------------------------------------------- OSC */

  const osc = dgram.createSocket('udp4');
  const send = (address, args = []) => {
    if (!state.feedback) return;
    osc.send(encode(address, args), state.feedback.port, state.feedback.host);
  };

  function sendTimes() {
    const c = cue();
    send('/mitti/playhead', [{ type: 'f', value: c ? state.at / c.seconds : 0 }]);
    send('/mitti/cueTimeElapsed', [tc(state.at)]);
    send('/mitti/cueTimeLeft', [tc(c ? c.seconds - state.at : 0)]);
    send('/mitti/time', [tc(state.cues.slice(0, state.current).reduce((t, x) => t + x.seconds, 0) + state.at)]);
  }

  function sendMaster() {
    const c = cue();
    const at = (i) => state.cues[i]?.name ?? '';
    send('/mitti/togglePlay', [state.playing ? 1 : 0]);
    send('/mitti/currentCueName', [c?.name ?? '']);
    send('/mitti/currentCueID', [c?.id ?? '']);
    send('/mitti/currentCueTRT', [tc(c?.seconds ?? 0)]);
    send('/mitti/nextCueName', [at(state.current + 1)]);
    send('/mitti/previousCueName', [at(state.current - 1)]);
    send('/mitti/selectedCueName', [at(state.selected)]);
    send('/mitti/selectedCueID', [state.cues[state.selected]?.id ?? '']);
    sendTimes();
  }

  function sendAll() {
    state.cues.forEach((c, i) => send(`/mitti/${i + 1}/cueName`, [c.name]));
    sendMaster();
  }

  const clampIndex = (i) => Math.min(state.cues.length - 1, Math.max(0, i));
  const go = (i, { play } = {}) => {
    state.current = clampIndex(i);
    state.at = 0;
    state.selected = clampIndex(state.current + 1);
    if (play !== undefined) state.playing = play;
    sendMaster();
    pushTransport();
  };
  const setPlaying = (p) => { state.playing = p; sendMaster(); pushTransport(); };
  const cueRef = (ref) => {
    if (ref === 'current') return state.current;
    if (ref === 'next') return clampIndex(state.current + 1);
    if (ref === 'previous') return clampIndex(state.current - 1);
    if (ref === 'selected') return state.selected;
    const byId = state.cues.findIndex((c) => c.id === String(ref).toUpperCase());
    if (byId >= 0) return byId;
    const n = Number(ref);
    return Number.isInteger(n) && n >= 1 && n <= state.cues.length ? n - 1 : -1;
  };

  function command({ address, args }) {
    state.received.push({ address, args });
    const v = args[0];
    const parts = address.replace(/^\/mitti\//, '').split('/');
    if (parts.length === 2) {
      const i = cueRef(parts[0]);
      if (i < 0) return;
      if (parts[1] === 'play') go(i, { play: true });
      else if (parts[1] === 'jump') go(i);
      else if (parts[1] === 'select') { state.selected = i; sendMaster(); }
      return;
    }
    switch (parts[0]) {
      case 'ping': send('/mitti/pong'); break;
      case 'resendOSCFeedback': sendAll(); break;
      case 'play': case 'resume': setPlaying(true); break;
      case 'pause': case 'stop': setPlaying(false); break;
      case 'togglePause': setPlaying(!state.playing); break;
      case 'togglePlay': setPlaying(v === undefined ? !state.playing : Number(v) === 1); break;
      case 'rewind': state.at = 0; sendMaster(); pushTransport(); break;
      case 'goto10': case 'goto20': case 'goto30':
        state.at = Math.max(0, cue().seconds - Number(parts[0].slice(4))); sendTimes(); break;
      case 'playhead': state.at = Math.min(1, Math.max(0, Number(v))) * cue().seconds; sendTimes(); break;
      case 'jumpToNextCue': go(state.current + 1); break;
      case 'jumpToPrevCue': go(state.current - 1); break;
      case 'triggerNextCue': go(state.current + 1, { play: true }); break;
      case 'triggerPrevCue': go(state.current - 1, { play: true }); break;
      case 'selectNextCue': state.selected = clampIndex(state.selected + 1); sendMaster(); break;
      case 'selectPrevCue': state.selected = clampIndex(state.selected - 1); sendMaster(); break;
      case 'playSelectedCue': case 'playSelectedCueForceCut': go(state.selected, { play: true }); break;
      case 'jumpToSelectedCue': go(state.selected); break;
      case 'playCueAtIndex': case 'playCueAtIndexForceCut': {
        const i = Number(v) - 1;
        if (i >= 0 && i < state.cues.length) go(i, { play: true });
        break;
      }
      case 'playCueWithCueID': case 'playCueWithCueIDForceCut': {
        const i = cueRef(String(v));
        if (i >= 0) go(i, { play: true });
        break;
      }
      case 'playCueWithName': case 'playCueWithNameForceCut': {
        const i = state.cues.findIndex((c) => c.name === String(v));
        if (i >= 0) go(i, { play: true });
        break;
      }
      default: break;
    }
  }

  osc.on('message', (buf) => {
    let messages;
    try { messages = decode(buf); } catch { return; }
    messages.forEach(command);
  });
  await new Promise((resolve, reject) => {
    osc.once('error', reject);
    osc.bind(options.oscPort ?? 51000, host, resolve);
  });

  /* ---------------------------------------------------------------- the clock */

  let last = Date.now();
  let sinceSend = 0;
  const tickMs = options.tickMs ?? 20;
  const ticker = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!state.playing) return;
    const c = cue();
    state.at += dt;
    if (state.at >= c.seconds) {
      if (c.loop) state.at = 0;
      else if (c.pauseAtEnd || state.current === state.cues.length - 1) {
        state.at = c.seconds;
        setPlaying(false);
        return;
      } else {
        go(state.current + 1, { play: true });
        return;
      }
    }
    sinceSend += dt;
    if (sinceSend >= 0.1) { sinceSend = 0; sendTimes(); }
  }, tickMs);

  /* ---------------------------------------------------------------- HyperDeck */

  const clients = new Set();
  const startOf = (i) => state.cues.slice(0, i).reduce((t, c) => t + c.seconds, 0);
  const transportBlock = (code) => [
    `${code} transport info:`,
    `status: ${state.playing ? 'play' : 'stopped'}`,
    `speed: ${state.playing ? 100 : 0}`,
    'slot id: 1',
    `clip id: ${state.current + 1}`,
    'single clip: false',
    `display timecode: ${tc(startOf(state.current) + state.at)}`,
    `timecode: ${tc(startOf(state.current) + state.at)}`,
    `video format: ${FORMAT}`,
    'loop: false',
    '', ''].join('\r\n');
  function pushTransport() {
    for (const c of clients) if (c.notify) c.socket.write(transportBlock(508));
  }

  let hyperdeck = null;
  if (options.hyperdeckPort !== false) {
    hyperdeck = net.createServer((socket) => {
      const client = { socket, notify: false };
      clients.add(client);
      socket.setEncoding('utf8');
      socket.write('500 connection info:\r\nprotocol version: 1.11\r\nmodel: Mitti\r\n\r\n');
      let buffer = '';
      socket.on('data', (text) => {
        buffer += text;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).replace(/\r$/, '').trim();
          buffer = buffer.slice(i + 1);
          if (line) socket.write(answer(line, client));
        }
      });
      socket.on('close', () => clients.delete(client));
      socket.on('error', () => clients.delete(client));
    });
    await new Promise((resolve, reject) => {
      hyperdeck.once('error', reject);
      hyperdeck.listen(options.hyperdeckPort ?? 9993, host, resolve);
    });
  }

  function answer(line, client) {
    const [head, ...restParts] = line.split(':');
    const cmd = head.trim().toLowerCase();
    const rest = restParts.join(':');
    switch (cmd) {
      case 'ping': return '200 ok\r\n';
      case 'device info': return '204 device info:\r\nprotocol version: 1.11\r\nmodel: Mitti\r\nslot count: 1\r\n\r\n';
      case 'transport info': return transportBlock(208);
      case 'slot info': return '202 slot info:\r\nslot id: 1\r\nstatus: mounted\r\nvideo format: 1080p25\r\n\r\n';
      case 'clips count': return `214 clips count:\r\nclip count: ${state.cues.length}\r\n\r\n`;
      case 'clips get': return ['205 clips info:', `clip count: ${state.cues.length}`,
        ...state.cues.map((c, i) => `${i + 1}: ${c.name} ${tc(startOf(i))} ${tc(c.seconds)}`), '', ''].join('\r\n');
      case 'notify': client.notify = /transport:\s*true/i.test(rest); return '200 ok\r\n';
      case 'remote': return '200 ok\r\n';
      case 'play': setPlaying(true); return '200 ok\r\n';
      case 'stop': setPlaying(false); return '200 ok\r\n';
      case 'goto': {
        const id = /clip id:\s*([+-]?\d+)/i.exec(rest)?.[1];
        const where = /clip:\s*(start|end)/i.exec(rest)?.[1];
        if (id != null) {
          const target = /^[+-]/.test(id) ? state.current + Number(id) : Number(id) - 1;
          if (target < 0 || target >= state.cues.length) return '109 out of range\r\n';
          go(target);
        } else if (where === 'start') { state.at = 0; sendTimes(); pushTransport(); }
        else if (where === 'end') { state.at = cue().seconds - 1 / FPS; sendTimes(); pushTransport(); }
        return '200 ok\r\n';
      }
      default: return '100 syntax error\r\n';
    }
  }

  return {
    state,
    oscPort: osc.address().port,
    hyperdeckPort: hyperdeck ? hyperdeck.address().port : null,
    setFeedback(target) { state.feedback = target; },
    sendAll,
    close: () => new Promise((resolve) => {
      clearInterval(ticker);
      for (const c of clients) c.socket.destroy();
      osc.close();
      if (hyperdeck) hyperdeck.close(() => resolve()); else resolve();
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const [fbHost, fbPort] = String(opt('--feedback', '127.0.0.1:51010')).split(':');
  const sim = await startMittiSim({
    host: opt('--host', '127.0.0.1'),
    oscPort: Number(opt('--osc', 51000)),
    hyperdeckPort: args.includes('--no-hyperdeck') ? false : Number(opt('--hyperdeck', 9993)),
    feedback: { host: fbHost, port: Number(fbPort) },
  });
  console.log(`Mitti sim: OSC :${sim.oscPort}, HyperDeck :${sim.hyperdeckPort ?? 'off'}, feedback → ${fbHost}:${fbPort}`);
}
