#!/usr/bin/env node
/*
 * A QLab 5 workspace on this machine: OSC over TCP (SLIP), one cue list that
 * plays in real time.
 *
 *   node drivers/players/qlab/sim.mjs              listens on 127.0.0.1:53000, passcode 1234
 *   … --port 53010 --passcode 4321 --host 127.0.0.1
 *
 * What automitti's tests run against, and what to point it at without QLab.
 * Each behaviour here was seen on a real QLab 5.5.10 (docs/QLAB.md):
 *   - /version and /workspaces get no answer at all while no workspace is open;
 *   - /connect answers "ok:view|edit|control" (the passcode's permissions),
 *     "ok:" for a passcode-less connection the workspace gives nothing, or
 *     "badpass" — after which even the right passcode is "denied" for a while;
 *   - until a client has connected, every workspace message is "denied";
 *   - /updates is an application message: /workspace/<id>/updates is an error;
 *   - /cue/playhead/valuesForKeys is answered as /cue/<number>/valuesForKeys;
 *   - a cue that stops, or runs out, is reset at once: actionElapsed reads 0;
 *   - GO starts the playhead cue and moves the playhead to the next cue;
 *     /playhead/next from the last cue goes to the first.
 * The timing of the pushed updates is the real one's, roughly. It is an
 * emulation, not proof that QLab agrees.
 *
 * Loopback by default: a fake QLab on the show network is one a real QLab
 * remote could find.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encode, decode } from '../../../server/lib/osc.js';
import { slipEncode, SlipDecoder } from './slip.js';

const VERSION = '5.5.10';

export const DEFAULT_CUES = [
  { number: '1', name: 'Walk-in loop', type: 'Video', seconds: 30 },
  { number: '2', name: 'House to half', type: 'Light', seconds: 3 },
  { number: '3', name: 'Opener', type: 'Video', seconds: 12 },
  { number: '4', name: 'Sponsor reel', type: 'Video', seconds: 20 },
  { number: '5', name: 'Applause sting', type: 'Audio', seconds: 4 },
  { number: '6', name: 'Award VT 1', type: 'Video', seconds: 45 },
];

/**
 * @param {{port?:number, host?:string, passcode?:string, permissions?:string,
 *          noPasscode?:string, name?:string, cues?:Array, lockoutMs?:number}} options
 *   noPasscode: the permissions of a connection without a passcode — '' (none) by
 *   default, as in a new QLab 5 workspace.
 */
export async function startQLabSim(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const passcode = options.passcode ?? '1234';
  const permissions = options.permissions ?? 'view|edit|control';
  const noPasscode = options.noPasscode ?? '';
  const lockoutMs = options.lockoutMs ?? 1000;
  const list = { id: randomUUID().toUpperCase(), number: '', name: 'Main Cue List', type: 'Cue List' };
  const state = {
    workspace: { id: randomUUID().toUpperCase(), name: options.name ?? 'Show', open: true },
    list,
    cues: (options.cues || DEFAULT_CUES).map((c) => ({
      id: c.id ?? randomUUID().toUpperCase(),
      number: c.number ?? '',
      name: c.name ?? '',
      type: c.type ?? 'Video',
      seconds: c.seconds ?? 10,
      run: 'idle',      // idle | running | paused
      base: 0,          // seconds elapsed when it last started or paused
      since: 0,         // ms when it last started running
    })),
    playhead: null,
    received: [],       // every message from every client, for tests
  };
  state.playhead = state.cues[0]?.id ?? null;
  const clients = new Set();
  const ws = state.workspace;

  const byId = (id) => state.cues.find((c) => c.id === id);
  const elapsed = (c) => (c.run === 'running' ? c.base + (Date.now() - c.since) / 1000 : c.run === 'paused' ? c.base : 0);

  /* ---------------------------------------------------------------- wire */

  const send = (cl, address, args = []) => { if (!cl.sock.destroyed) cl.sock.write(slipEncode(encode(address, args))); };
  function reply(cl, address, status, data, scoped = true) {
    const body = { address, status };
    if (scoped) body.workspace_id = ws.id;
    if (data !== undefined) body.data = data;
    send(cl, `/reply${address}`, [JSON.stringify(body)]);
  }
  function push(path, args = []) {
    for (const cl of clients) if (cl.updates) send(cl, `/update/workspace/${ws.id}${path}`, args);
  }
  /* QLab pushes "cue changed" for the cue, its list and the root on every state change. */
  const changed = (c) => { push(`/cue_id/${c.id}`); push(`/cue_id/${list.id}`); push('/cue_id/__root__'); };
  const movePlayhead = (id) => {
    state.playhead = id;
    push(`/cueList/${list.id}/playbackPosition`, id ? [id] : []);
  };

  /* ---------------------------------------------------------------- playback */

  function start(c) {
    if (c.run === 'running') return;
    c.run = 'running';
    c.base = 0;
    c.since = Date.now();
    changed(c);
  }
  function pause(c) {
    if (c.run !== 'running') return;
    c.base = elapsed(c);
    c.run = 'paused';
    changed(c);
  }
  function resume(c) {
    if (c.run !== 'paused') return;
    c.run = 'running';
    c.since = Date.now();
    changed(c);
  }
  function stop(c) {
    if (c.run === 'idle') return;
    c.run = 'idle';
    c.base = 0;
    changed(c);
  }
  function go() {
    const c = byId(state.playhead);
    if (!c) return;
    const i = state.cues.indexOf(c);
    movePlayhead(state.cues[i + 1]?.id ?? null);
    start(c);
  }
  function step(dir) {
    const i = state.cues.findIndex((c) => c.id === state.playhead);
    const n = state.cues.length;
    if (!n) return;
    /* Seen on QLab 5.5.10: next from the last cue goes to the first. */
    const to = i < 0 ? 0 : dir > 0 ? (i + 1) % n : Math.max(0, i - 1);
    movePlayhead(state.cues[to].id);
  }

  const ticker = setInterval(() => {
    for (const c of state.cues) {
      if (c.run === 'running' && elapsed(c) >= c.seconds) {
        c.run = 'idle';
        c.base = 0;
        changed(c);
      }
    }
  }, 20);

  /* ---------------------------------------------------------------- dictionaries */

  const listName = (c) => c.name || `${c.type.toLowerCase()} cue`;
  const cueDict = (c) => ({
    number: c.number, uniqueID: c.id, cues: [], 'colorName/live': 'none', flagged: false,
    listName: listName(c), type: c.type, colorName: 'none', name: c.name, armed: true,
  });
  const listDict = () => ({
    number: list.number, uniqueID: list.id, cues: state.cues.map(cueDict), 'colorName/live': 'none',
    flagged: false, listName: list.name, type: list.type, colorName: 'none', name: list.name, armed: true,
  });
  function values(c, keys) {
    const t = elapsed(c);
    const all = {
      uniqueID: c.id, number: c.number, name: c.name, listName: listName(c), displayName: listName(c), type: c.type,
      duration: c.seconds, currentDuration: c.seconds, actionElapsed: t, percentActionElapsed: c.seconds ? t / c.seconds : 0,
      isRunning: c.run === 'running', isPaused: c.run === 'paused', isActionRunning: c.run === 'running',
      isLoaded: c.run !== 'idle', preWaitElapsed: 0,
    };
    return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
  }

  /* ---------------------------------------------------------------- messages */

  const can = (cl, perm) => cl.perms.includes(perm);

  function onMessage(cl, { address, args }) {
    state.received.push({ address, args });
    if (address === '/version') { if (ws.open) reply(cl, address, 'ok', VERSION, false); return; }
    if (address === '/workspaces') {
      if (ws.open) reply(cl, address, 'ok', [{ version: VERSION, displayName: ws.name, udpReplyPort: 53001, uniqueID: ws.id, port: 53000 }], false);
      return;
    }
    if (address === '/updates') {
      if (!cl.connected) return reply(cl, address, 'denied', undefined, false);
      if (args.length) { cl.updates = !!Number(args[0]); return undefined; }
      return reply(cl, address, 'ok', cl.updates, false);
    }
    if (address === '/disconnect') { cl.connected = false; cl.updates = false; cl.perms = []; return undefined; }
    if (!ws.open) return undefined;

    let path = address;
    const scoped = /^\/workspace\/([^/]+)(\/.*)$/.exec(address);
    if (scoped) {
      if (scoped[1] !== ws.id && scoped[1] !== ws.name) return undefined;
      path = scoped[2];
    }
    const full = `/workspace/${ws.id}${path}`;

    if (path === '/connect') {
      if (Date.now() < cl.lockedUntil) return reply(cl, full, 'denied');
      const given = args[0] == null ? '' : String(args[0]);
      const perms = given === '' ? noPasscode : given === passcode ? permissions : null;
      if (perms == null) {
        cl.bad += 1;
        cl.lockedUntil = Date.now() + lockoutMs * cl.bad;
        return reply(cl, full, 'ok', 'badpass');
      }
      cl.connected = true;
      cl.perms = perms.split('|').filter(Boolean);
      return reply(cl, full, 'ok', `ok:${perms}`);
    }
    if (!cl.connected) return reply(cl, full, 'denied');
    if (path === '/updates') return reply(cl, full, 'error');

    const view = () => can(cl, 'view') || (reply(cl, full, 'denied'), false);
    const control = () => can(cl, 'control') || (reply(cl, full, 'denied'), false);
    const edit = () => can(cl, 'edit') || (reply(cl, full, 'denied'), false);
    const active = () => state.cues.filter((c) => c.run !== 'idle');

    switch (path) {
      case '/thump': return view() && reply(cl, full, 'ok', 'thump');
      case '/cueLists': return view() && reply(cl, full, 'ok', [listDict()]);
      case '/runningOrPausedCues': return view() && reply(cl, full, 'ok', active().map(cueDict));
      case '/runningCues': return view() && reply(cl, full, 'ok', active().filter((c) => c.run === 'running').map(cueDict));
      case '/runningOrPausedCues/uniqueIDs': return view() && reply(cl, full, 'ok', active().map((c) => c.id));
      case '/currentCueListID': return view() && reply(cl, full, 'ok', list.id);
      case '/currentCueList': return view() && reply(cl, full, 'ok', list.number);
      case '/go': return control() && go();
      case '/pause': return control() && state.cues.forEach(pause);
      case '/resume': return control() && state.cues.forEach(resume);
      case '/stop': case '/hardStop': return control() && state.cues.forEach(stop);
      case '/reset': if (control()) { state.cues.forEach(stop); movePlayhead(state.cues[0]?.id ?? null); } return undefined;
      case '/playhead/next': case '/playbackPosition/next': return control() && step(1);
      case '/playhead/previous': case '/playbackPosition/previous': return control() && step(-1);
      default: break;
    }

    const playheadTo = /^\/(?:playhead|playbackPosition)\/(.+)$/.exec(path);
    if (playheadTo) {
      const c = state.cues.find((x) => x.number === playheadTo[1]);
      return control() && c && movePlayhead(c.id);
    }

    const m = /^\/(cue|cue_id)\/([^/]+)\/(.+)$/.exec(path);
    if (!m) return reply(cl, full, 'error');
    const [, how, key, method] = m;
    if (how === 'cue_id' && key === list.id) return onList(cl, full, method, args, { view, control });
    const c = how === 'cue_id' ? byId(key)
      : key === 'playhead' || key === 'playbackPosition' ? byId(state.playhead)
        : state.cues.find((x) => x.number === key);
    if (!c) return reply(cl, full, 'error');
    /* QLab answers a cue reached through a special name under its number (or id). */
    const as = how === 'cue' && (key === 'playhead' || key === 'playbackPosition')
      ? `/workspace/${ws.id}/${c.number ? `cue/${c.number}` : `cue_id/${c.id}`}/${method}` : full;

    switch (method) {
      case 'valuesForKeys': {
        let keys;
        try { keys = JSON.parse(args[0]); } catch { return undefined; } // "invalid use has no effect"
        return view() && reply(cl, as, 'ok', values(c, Array.isArray(keys) ? keys : []));
      }
      case 'start': return control() && start(c);
      case 'stop': case 'hardStop': return control() && stop(c);
      case 'pause': return control() && pause(c);
      case 'resume': return control() && resume(c);
      case 'go': if (control()) { movePlayhead(c.id); go(); } return undefined;
      case 'name':
        if (!args.length) return view() && reply(cl, as, 'ok', c.name);
        if (edit()) { c.name = String(args[0]); changed(c); }
        return undefined;
      case 'duration':
        if (!args.length) return view() && reply(cl, as, 'ok', c.seconds);
        if (edit()) { c.seconds = Number(args[0]); changed(c); }
        return undefined;
      default: return reply(cl, as, 'error');
    }
  }

  function onList(cl, full, method, args, { view, control }) {
    switch (method) {
      case 'go': return control() && go();
      case 'playheadID':
      case 'playbackPositionID': {
        if (!args.length) return view() && reply(cl, full, 'ok', state.playhead ?? 'none');
        if (!control()) return undefined;
        const v = String(args[0]);
        if (v === 'none') return movePlayhead(null);
        if (v === 'next') return step(1);
        if (v === 'previous') return step(-1);
        const c = byId(v) || state.cues.find((x) => x.number === v);
        return c && movePlayhead(c.id);
      }
      case 'playhead/next': case 'playbackPosition/next': return control() && step(1);
      case 'playhead/previous': case 'playbackPosition/previous': return control() && step(-1);
      default: return reply(cl, full, 'error');
    }
  }

  /* ---------------------------------------------------------------- server */

  const server = net.createServer((sock) => {
    const cl = { sock, connected: false, perms: [], updates: false, bad: 0, lockedUntil: 0 };
    clients.add(cl);
    sock.setNoDelay(true);
    const decoder = new SlipDecoder((frame) => {
      let messages;
      try { messages = decode(frame); } catch { return; }
      for (const m of messages) onMessage(cl, m);
    });
    sock.on('data', (chunk) => decoder.push(chunk));
    sock.on('error', () => {});
    sock.on('close', () => clients.delete(cl));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 53000, host, resolve);
  });

  return {
    port: server.address().port,
    passcode,
    state,
    /** The cue with this name or number. */
    cue: (key) => state.cues.find((c) => c.name === key || c.number === key) || null,
    elapsed,
    /** Close the workspace, as closing its window does: connected clients are told to go. */
    closeWorkspace() { push('/disconnect'); ws.open = false; for (const cl of clients) { cl.connected = false; cl.updates = false; } },
    openWorkspace() { ws.open = true; },
    /** Drop every connection, as quitting QLab does. */
    dropClients() { for (const cl of clients) cl.sock.destroy(); },
    close: () => new Promise((resolve) => {
      clearInterval(ticker);
      for (const cl of clients) cl.sock.destroy();
      server.close(() => resolve());
    }),
  };
}

/* ------------------------------------------------------------------ CLI */

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const sim = await startQLabSim({
    port: Number(arg('port', 53000)),
    host: arg('host', '127.0.0.1'),
    passcode: arg('passcode', '1234'),
  });
  console.log(`QLab simulator on ${arg('host', '127.0.0.1')}:${sim.port} — workspace “${sim.state.workspace.name}”, passcode ${sim.passcode}`);
  for (const c of sim.state.cues) console.log(`  ${c.number.padStart(2)}  ${c.type.padEnd(6)} ${String(c.seconds).padStart(4)} s  ${c.name}`);
}
