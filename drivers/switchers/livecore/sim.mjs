#!/usr/bin/env node
/*
 * An Analog Way frame on Analog Way's mnemonic protocol, TCP 10500 — a
 * LiveCore (NeXtage 16) or a Midra (Pulse²), for the livecore and
 * midra-classic drivers. Both families share the protocol, so one simulator
 * does both.
 *
 *   node drivers/switchers/livecore/sim.mjs [--family livecore|midra] [--port 10500]
 *
 * It carries only what a switcher driver touches, and the behaviour openRCS
 * found on real units (docs/PROTOCOL.md and docs/NOTES.md in openRCS):
 *
 *  - LiveCore: PRinp[screen, bank, layer] in banks PA/PB; GCsta names the bank
 *    on air; the T-bar GCtba (0 = PA, 65535 = PB) is what takes; the device's
 *    own GCtku/GCtkd stall in EFFECT_FROM_* until GCtfr. With CTpmu at 1 a
 *    source write is held until GCupd.
 *  - Midra: PRinp[screen, ctx, layer], ctx 0 program and 1 preview, layer 0
 *    the frame layer; GCtak takes (and is dead while CTpmu is 1, where RCS2
 *    leaves it); a cut is the T-bar GCtba 0..10000, which only lands if it is
 *    seen to travel; a source with no signal is dropped without a word.
 *
 * An emulation of what was observed, not proof that a frame agrees.
 * Loopback by default.
 */

import net from 'node:net';
import { fileURLToPath } from 'node:url';

const FAMILIES = {
  livecore: {
    term: '\n', dev: 105, pdev: 97, screens: 8, banks: 3, layers: 24, inputs: 24, sources: 41,
    vars: { SCssh: [8], SCmly: [8], Plngr: [8], INava: [24], INplg: [24], LBInp: [24, 6, 16], PRinp: [8, 3, 24], GCsta: [16], GCtba: [16], GCtku: [16], GCtkd: [16], GCtfr: [16], GCupd: [], CTpmu: [] },
  },
  midra: {
    term: '\r\n', dev: 259, screens: 2, banks: 3, layers: 8, inputs: 10, sources: 11,
    vars: { SCssh: [2], SCmly: [2], INava: [10], PRinp: [2, 3, 8], GCtak: [2], GCtba: [2], GCtav: [2], CTpmu: [] },
  },
};
const LIVECORE_BAR = 65535;
const MIDRA_BAR = 10000;

export async function startAwSim(options = {}) {
  const family = options.family === 'midra' ? 'midra' : 'livecore';
  const F = FAMILIES[family];
  const state = {
    family,
    values: new Map(),          // "MNEM:i,j" → number
    pending: new Map(),         // LiveCore, CTpmu 1: PRinp writes waiting for GCupd
    signal: new Set(options.signal || [1, 2, 3, 4, 5, 7]),
    log: [],                    // every line received
    takeMs: options.takeMs ?? 300,
  };
  const k = (m, idx) => `${m}:${idx.join(',')}`;
  const get = (m, ...idx) => state.values.get(k(m, idx)) ?? 0;
  const put = (m, idx, v) => state.values.set(k(m, idx), v);

  /* ------------------------------------------------ the frame */
  for (let s = 0; s < F.screens; s += 1) {
    put('SCssh', [s], s < 2 ? 1 : 0);
    put('SCmly', [s], s < 2 ? 2 : 0);
    if (family === 'livecore') put('Plngr', [s], s);
  }
  for (let i = 0; i < F.inputs; i += 1) put('INava', [i], family === 'midra' || i < 8 ? 1 : 0);
  if (family === 'livecore') {
    const labels = ['CAM 1', 'CAM 2', 'MITTI', 'PPT', '', '', '', ''];
    for (let i = 0; i < F.inputs; i += 1) {
      put('INplg', [i], 4);
      [...(labels[i] || '')].forEach((ch, c) => put('LBInp', [i, 4, c], ch.charCodeAt(0)));
    }
    put('PRinp', [0, 0, 0], 1); put('PRinp', [0, 1, 0], 2);
    put('PRinp', [1, 0, 0], 1); put('PRinp', [1, 1, 0], 2);
    put('CTpmu', [], options.pmu ?? 0);
  } else {
    put('PRinp', [0, 0, 1], 1); put('PRinp', [0, 1, 1], 2);
    put('PRinp', [1, 0, 1], 5); put('PRinp', [1, 1, 1], 7);
    put('PRinp', [0, 0, 0], 11); put('PRinp', [0, 1, 0], 11); // colour on the frame layer
    put('CTpmu', [], options.pmu ?? 1); // where RCS2 leaves it
    for (let s = 0; s < F.screens; s += 1) put('GCtav', [s], 1);
  }

  const clients = new Set();
  const send = (sock, line) => sock.write(`${line}\r\n`);
  const broadcast = (m, idx) => { for (const c of clients) send(c, `${m}${[...idx, get(m, ...idx)].join(',')}`); };
  const set = (m, idx, v) => { put(m, idx, v); broadcast(m, idx); };

  /* ------------------------------------------------ LiveCore takes */
  const liveBank = (g) => [1, 3, 5].includes(get('GCsta', g)) ? 1 : 0;
  function liveCoreBar(g, v) {
    const from = liveBank(g);
    put('GCtba', [g], v);
    if (v === 0) set('GCsta', [g], 0);
    else if (v === LIVECORE_BAR) set('GCsta', [g], 1);
    else if (get('GCsta', g) < 2) set('GCsta', [g], from === 0 ? 2 : 3);
  }

  /* ------------------------------------------------ Midra takes */
  const midraTake = (s) => {
    for (let l = 0; l < F.layers; l += 1) set('PRinp', [s, 0, l], get('PRinp', s, 1, l));
  };
  const bar = new Map(); // screen → { rest, moving }
  function midraBar(s, v) {
    const b = bar.get(s) || { rest: 0, moving: false };
    put('GCtba', [s], v);
    const end = v === 0 || v === MIDRA_BAR;
    if (!end) b.moving = true;
    else if (b.moving && v !== b.rest) { midraTake(s); b.rest = v; b.moving = false; }
    else b.moving = false; // a jump straight to an end is ignored, as on a Pulse²
    bar.set(s, b);
  }

  function apply(m, idx, v, sock) {
    if (m === 'PRinp' && family === 'midra') {
      const [, , l] = idx;
      /* A Midra will not put a live layer on an input with no signal, and says nothing. */
      if (l > 0 && v >= 1 && v <= F.inputs && !state.signal.has(v)) return;
      return set(m, idx, v);
    }
    if (m === 'PRinp' && get('CTpmu') === 1) {
      state.pending.set(k(m, idx), [idx, v]);
      return send(sock, `${m}${[...idx, v].join(',')}`); // accepted and echoed; nothing moves
    }
    switch (m) {
      case 'GCupd':
        for (const [i, val] of state.pending.values()) set('PRinp', i, val);
        state.pending.clear();
        return undefined;
      case 'GCtba': return family === 'midra' ? midraBar(idx[0], v) : liveCoreBar(idx[0], v);
      /* The LiveCore's own take verbs stall on hardware: EFFECT_FROM_* and no further. */
      case 'GCtku': case 'GCtkd':
        if (v === 1) set('GCsta', [idx[0]], liveBank(idx[0]) === 0 ? 2 : 3);
        return undefined;
      case 'GCtfr':
        if (v === 1 && get('GCsta', idx[0]) >= 2) liveCoreBar(idx[0], [3, 5].includes(get('GCsta', idx[0])) ? 0 : LIVECORE_BAR);
        return undefined;
      case 'GCtak': {
        const was = get('GCtak', idx[0]);
        set(m, idx, v);
        /* Dead in preset-update mode: it latches at 1 and nothing moves. */
        if (v === 1 && was === 0 && get('CTpmu') === 0) {
          setTimeout(() => { midraTake(idx[0]); set('GCtak', idx, 0); }, state.takeMs);
        }
        return undefined;
      }
      default: return set(m, idx, v);
    }
  }

  function onLine(sock, line) {
    state.log.push(line);
    if (line === '?') return send(sock, `DEV${F.dev}`);
    if (line === '!') return send(sock, F.pdev ? `PDEV${F.pdev}` : 'E10');
    const m = /^((?:-?\d+,)*)(-?\d+)?([A-Za-z]+)$/.exec(line);
    if (!m || !(m[3] in F.vars)) return send(sock, 'E10');
    const idx = m[1] ? m[1].slice(0, -1).split(',').map(Number) : [];
    const dims = F.vars[m[3]];
    if (idx.length !== dims.length || idx.some((i, n) => i < 0 || i >= dims[n])) return send(sock, 'E12');
    if (m[2] == null) return send(sock, `${m[3]}${[...idx, get(m[3], ...idx)].join(',')}`);
    return apply(m[3], idx, Number(m[2]), sock);
  }

  const server = net.createServer((sock) => {
    clients.add(sock);
    let buf = '';
    sock.setEncoding('latin1');
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line) onLine(sock, line);
      }
    });
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => {});
    /* A LiveCore pushes its connected-controller count soon after accept (1.2 s on a NeXtage). */
    if (family === 'livecore') setTimeout(() => !sock.destroyed && send(sock, 'ITcct0,1'), 100);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 10500, options.host ?? '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    state,
    get: (m, ...idx) => get(m, ...idx),
    set: (m, idx, v) => set(m, idx, v),
    close: () => new Promise((resolve) => { for (const c of clients) c.destroy(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, f) => (args.includes(n) ? args[args.indexOf(n) + 1] : f);
  const family = opt('--family', 'livecore');
  const sim = await startAwSim({ family, port: Number(opt('--port', 10500)), host: opt('--host', '127.0.0.1') });
  console.log(`${family === 'midra' ? 'Midra (Pulse²)' : 'LiveCore (NeXtage 16)'} sim on :${sim.port}`);
}
