#!/usr/bin/env node
/*
 * automitti — the server the tray app runs.
 *
 *   node server/index.js [--data <dir>] [--port <http port>]
 *
 * One process holds every link: the devices (each a media player — a player
 * driver, Mitti built in — with its NDI tally and rules), the one switcher (a
 * switcher driver) they are all on, the emulated ATEM, and the web pages.
 * Settings live in <data>/config.json and are edited from the page at /.
 * Drivers are found in <app>/drivers and <data>/drivers — docs/DRIVERS.md.
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ConfigStore, dataDir } from './config.js';
import { Registry, BUILTIN } from './core/registry.js';
import { Switcher } from './core/switcher.js';
import { Devices } from './devices.js';
import { AtemBridge } from './atem/bridge.js';
import { Advertiser } from './bonjour.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..', 'web');
const PKG = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8'));
const VERSION = PKG.version;
/* "preview" while the switcher drivers have not met real hardware; shown beside the version everywhere. */
const STAGE = PKG.stage || '';

const logLines = [];
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  console.log(line);
  broadcast({ type: 'log', line });
}

const DATA = dataDir();
const store = new ConfigStore(DATA);
/* Built-in drivers, then the user's, which may add or replace. */
const registry = await Registry.load([BUILTIN, path.join(DATA, 'drivers')], { log: (m) => console.log(m) });
/* The tray app injects AUTOMITTI_PORT/HOST; a command line may say --port. Either beats the settings file. */
const argPort = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1])
  : (Number(process.env.AUTOMITTI_PORT) || null);
const argHost = process.env.AUTOMITTI_HOST || null;
const config = () => store.get();

const switcher = new Switcher({ config, registry, log });
const devices = new Devices({ config, switcher, registry, log });
const atem = new AtemBridge({ config, switcher, log });
const bonjour = new Advertiser({ log });

/* ------------------------------------------------------------ web */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

function status() {
  return {
    version: VERSION,
    stage: STAGE,
    config: config(),
    drivers: registry.list(),
    devices: devices.snapshot(),
    switcher: switcher.snapshot(),
    atem: atem.snapshot(),
    addresses: Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
      .filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address }))),
    announcing,
  };
}

/* The device a request names (`device`: an id or a name), the first one when it names none. */
function deviceFor(key) {
  const device = devices.get(key);
  if (!device) throw Object.assign(new Error(`no device called "${key}"`), { status: 404 });
  return device;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/status') return json(res, status());
    if (url.pathname === '/api/log') return json(res, logLines);
    if (url.pathname === '/api/config' && req.method === 'PUT') {
      const prev = config();
      const next = store.set(await body(req));
      await applyConfig(prev, next);
      return json(res, next);
    }
    if (url.pathname === '/api/devices' && req.method === 'POST') {
      const { type, name } = await body(req);
      const draft = devices.draft(type ? String(type) : undefined);
      if (!registry.player(draft.player.type)) return json(res, { error: `no player driver called "${draft.player.type}" is installed` }, 400);
      if (name) draft.name = String(name);
      const prev = config();
      const next = store.set({ ...prev, devices: [...prev.devices, draft] });
      await applyConfig(prev, next);
      return json(res, { device: next.devices.at(-1), config: next });
    }
    const one = /^\/api\/devices\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === 'DELETE') {
      const device = deviceFor(decodeURIComponent(one[1]));
      const prev = config();
      if (prev.devices.length < 2) return json(res, { error: 'the last device cannot be removed' }, 409);
      const next = store.set({ ...prev, devices: prev.devices.filter((d) => d.id !== device.id) });
      await applyConfig(prev, next);
      return json(res, { config: next });
    }
    /* /api/mitti is the v0.1.0 spelling, kept so Companion buttons made for it still work.
       With no `device` (in the body or the query) it is the first device, as it was. */
    if ((url.pathname === '/api/player' || url.pathname === '/api/mitti') && req.method === 'POST') {
      const { device: key = url.searchParams.get('device'), action, address, args, via } = await body(req);
      const { player } = deviceFor(key);
      if (address) player.command(String(address), Array.isArray(args) ? args : []);
      else await player.act(String(action), via);
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/switcher' && req.method === 'POST') {
      const { action, input } = await body(req);
      await switcher.command(String(action), input);
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/ndi/sources') return json(res, await deviceFor(url.searchParams.get('device')).ndi.sources());
    if (url.pathname.startsWith('/api/')) return json(res, { error: 'not found' }, 404);
    return serveStatic(url.pathname, res);
  } catch (err) {
    log(`HTTP ${req.method} ${url.pathname}: ${err.message}`);
    return json(res, { error: err.message }, err.status || 500);
  }
});

function serveStatic(pathname, res) {
  const aliases = { '/': '/index.html', '/display': '/display.html' };
  const rel = aliases[pathname] || pathname;
  const file = path.resolve(WEB, `.${decodeURIComponent(rel)}`);
  if (!file.startsWith(WEB + path.sep)) return json(res, { error: 'not found' }, 404);
  fs.readFile(file, (err, data) => {
    if (err) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function json(res, value, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ live push */

const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const c of wss?.clients || []) if (c.readyState === 1) c.send(text);
}
wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'status', status: status() })));

/* Coalesce: the timecode feedback arrives ~10×/s and a display needs no more. */
let pending = null;
function schedule() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; broadcast({ type: 'status', status: status() }); }, 50);
}
devices.on('change', schedule);
switcher.on('change', schedule);
atem.on('change', schedule);
setInterval(schedule, 1000);

/* ------------------------------------------------------------ lifecycle */

/* One at a time: two saves in quick succession must not start a device twice. */
let applying = Promise.resolve();
function applyConfig(prev) {
  const run = applying.then(async () => {
    await devices.reconfigure();
    await switcher.reconfigure(prev);
    await atem.reconfigure(prev);
    advertise();
    log('settings saved');
    schedule();
  });
  applying = run.catch(() => {});
  return run;
}

const localIPv4 = () => Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);

/* What is being announced: the pinned address while it exists on this machine,
   every interface otherwise. A Mac that changes network loses its old address,
   and announcing a dead one sends the player nowhere. */
let announcing = { pinned: '', address: '', fallback: false };

function advertise() {
  const c = config();
  const here = localIPv4();
  const fallback = !!c.advertiseAddress && !here.includes(c.advertiseAddress);
  if (fallback && !announcing.fallback) log(`${c.advertiseAddress} is not on this machine any more — announcing on every interface until it is`);
  if (!fallback && announcing.fallback && c.advertiseAddress) log(`${c.advertiseAddress} is back — announcing on it alone`);
  const address = c.advertiseAddress && !fallback ? c.advertiseAddress : undefined;
  announcing = { pinned: c.advertiseAddress, address: address || '', fallback };
  bonjour.set([
    ...devices.bonjour(),
    ...(c.atem.enabled && c.atem.advertise ? atem.bonjourServices() : []),
  ].map((spec) => ({ ...spec, address })));
}

/* Re-announce when the machine's addresses change (a network move, a VPN
   coming up): Bonjour records carry addresses, and a stale one strands the player. */
let lastAddresses = '';
setInterval(() => {
  const now = localIPv4().sort().join(',');
  if (lastAddresses && now !== lastAddresses) {
    log(`network addresses changed (${now || 'none'}) — re-announcing`);
    bonjour.stop();
    advertise();
    schedule();
  }
  lastAddresses = now;
}, 10000).unref();

async function main() {
  const port = argPort || config().httpPort;
  await devices.start();
  await switcher.start();
  await atem.start();
  advertise();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, argHost || config().httpBind, resolve);
  });
  const players = devices.list().map((d) => `${d.name} (${d.player.snapshot().label})`).join(', ');
  log(`automitti ${VERSION}${STAGE ? ` (${STAGE})` : ''} on http://localhost:${port}/ (display: /display) — ${players}; switcher ${switcher.snapshot().label}`);
  for (const p of registry.problems) log(`driver not loaded: ${p.path}: ${p.problems.join('; ')}`);
}

function shutdown() {
  log('stopping');
  bonjour.stop();
  devices.stop();
  switcher.stop();
  atem.stop();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
