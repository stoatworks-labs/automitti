#!/usr/bin/env node
/*
 * automitti — the server the tray app runs.
 *
 *   node server/index.js [--data <dir>] [--port <http port>]
 *
 * One process holds every link: Mitti (OSC + HyperDeck), the switcher driver,
 * the emulated ATEM, NDI tally, the rules, and the web pages. Settings live in
 * <data>/config.json and are edited from the page at /.
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ConfigStore, dataDir } from './config.js';
import { Mitti } from './mitti/index.js';
import { Switcher } from './switchers/index.js';
import { AtemBridge } from './atem/bridge.js';
import { NdiTally } from './ndi/tally.js';
import { Rules } from './rules.js';
import { Advertiser } from './bonjour.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..', 'web');
const VERSION = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')).version;

const logLines = [];
function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  console.log(line);
  broadcast({ type: 'log', line });
}

const store = new ConfigStore(dataDir());
/* The tray app injects AUTOMITTI_PORT/HOST; a command line may say --port. Either beats the settings file. */
const argPort = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1])
  : (Number(process.env.AUTOMITTI_PORT) || null);
const argHost = process.env.AUTOMITTI_HOST || null;
const config = () => store.get();

const mitti = new Mitti({ config, log });
const switcher = new Switcher({ config, log });
const atem = new AtemBridge({ config, switcher, log });
const ndi = new NdiTally({ config, switcher, log });
const rules = new Rules({ config, switcher, mitti, log });
const bonjour = new Advertiser({ log });

/* ------------------------------------------------------------ web */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

function status() {
  return {
    version: VERSION,
    config: config(),
    mitti: mitti.snapshot(),
    switcher: switcher.snapshot(),
    atem: atem.snapshot(),
    addresses: Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || [])
      .filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address }))),
    ndi: ndi.snapshot(),
    rules: rules.snapshot(),
  };
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
    if (url.pathname === '/api/mitti' && req.method === 'POST') {
      const { action, address, args } = await body(req);
      if (address) mitti.send(String(address), Array.isArray(args) ? args : []);
      else await mitti.act(String(action));
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/switcher' && req.method === 'POST') {
      const { action, input } = await body(req);
      await switcher.command(String(action), input);
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/ndi/sources') return json(res, await ndi.sources());
    if (url.pathname.startsWith('/api/')) return json(res, { error: 'not found' }, 404);
    return serveStatic(url.pathname, res);
  } catch (err) {
    log(`HTTP ${req.method} ${url.pathname}: ${err.message}`);
    return json(res, { error: err.message }, 500);
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
mitti.on('change', schedule);
switcher.on('change', schedule);
atem.on('change', schedule);
ndi.on('change', schedule);
rules.on('change', schedule);
setInterval(schedule, 1000);

/* ------------------------------------------------------------ lifecycle */

async function applyConfig(prev, next) {
  await mitti.reconfigure(prev);
  await switcher.reconfigure(prev);
  await atem.reconfigure(prev);
  await ndi.reconfigure(prev);
  advertise();
  log('settings saved');
  schedule();
}

function advertise() {
  const c = config();
  const address = c.advertiseAddress || undefined;
  bonjour.set([
    c.mitti.advertise && { key: 'osc', name: `automitti-${c.mitti.feedbackPort}`, type: 'osc', protocol: 'udp', port: c.mitti.feedbackPort },
    ...(c.atem.enabled && c.atem.advertise ? atem.bonjourServices() : []),
  ].filter(Boolean).map((spec) => ({ ...spec, address })));
}

async function main() {
  const port = argPort || config().httpPort;
  await mitti.start();
  await switcher.start();
  await atem.start();
  await ndi.start();
  rules.start();
  advertise();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, argHost || config().httpBind, resolve);
  });
  log(`automitti ${VERSION} on http://localhost:${port}/ (display: /display), Mitti feedback on UDP ${mitti.osc.listenPort}`);
}

function shutdown() {
  log('stopping');
  bonjour.stop();
  mitti.stop();
  switcher.stop();
  atem.stop();
  ndi.stop();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
