/*
 * The settings file: one JSON document, normalised on every read so a
 * hand-edited or older file can never put the server into a shape the code
 * does not expect.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDir(argv = process.argv, env = process.env) {
  const i = argv.indexOf('--data');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (env.AUTOMITTI_DATA) return path.resolve(env.AUTOMITTI_DATA);
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'automitti')
    : path.join(os.homedir(), '.automitti');
}

const int = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};
const str = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

export const RULE_VIA = ['osc', 'hyperdeck'];
export const ON_PROGRAM = ['play', 'none'];
export const ON_PREVIEW = ['none', 'rewind'];
export const ON_LEAVE = ['none', 'pause', 'rewind', 'next'];
export const ON_END = ['none', 'cut', 'auto'];

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const driverId = (v, fallback) => (ID.test(String(v ?? '')) || v === 'none' ? String(v) : fallback);

/* Per-driver settings are kept for EVERY driver ever configured, so switching
   type and back loses nothing. Each driver's own schema normalises its entry
   when it is used (core/contract.js normaliseSettings); here they are only
   kept as plain objects. */
const settingsMap = (v) => {
  const out = {};
  for (const [k, val] of Object.entries(v && typeof v === 'object' ? v : {})) {
    if (ID.test(k) && val && typeof val === 'object' && !Array.isArray(val)) out[k] = { ...val };
  }
  return out;
};

/**
 * Older files, carried across once, on read:
 *
 *  - v0.1.0 kept Mitti's settings at the top level (`mitti`) and one switcher's
 *    settings flat inside `switcher`, with the player's input as `mittiInput`.
 *  - v0.1.x had ONE player, with its relay list, input, NDI tally, rules and
 *    display title at the top level. They become the first device.
 */
function migrate(r) {
  const out = { ...r };
  if (r.mitti && !r.player) {
    out.player = { type: 'mitti', settings: { mitti: { ...r.mitti } } };
    delete out.mitti;
  }
  const sw = r.switcher;
  if (sw && !sw.settings && ('host' in sw || 'mittiInput' in sw)) {
    const { type = 'none', mittiInput, host, port, password, screens, layer } = sw;
    const flat = { host, port: port || undefined, password, screens, layer };
    for (const k of Object.keys(flat)) if (flat[k] === undefined || flat[k] === '') delete flat[k];
    out.switcher = { type, input: mittiInput ?? '', settings: type !== 'none' ? { [type]: flat } : {} };
  }
  const single = ['player', 'destinations', 'ndi', 'rules'];
  if (!Array.isArray(out.devices) && (single.some((k) => k in out) || (out.switcher && 'input' in out.switcher))) {
    out.devices = [{
      id: 'mitti',
      name: out.display?.title,
      player: out.player,
      destinations: out.destinations,
      ndi: out.ndi,
      rules: out.rules,
      input: out.switcher?.input,
    }];
    for (const k of single) delete out[k];
    /* Which NDI library to load is the machine's, not a device's. */
    if (r.ndi?.library) out.ndi = { library: r.ndi.library };
    if (out.switcher) { out.switcher = { ...out.switcher }; delete out.switcher.input; }
    if (out.display) { out.display = { ...out.display }; delete out.display.title; }
  }
  return out;
}

/* A switcher input is set as a number or a name; JSON may carry either. */
const inputSetting = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v));

const destinationList = (v) => (Array.isArray(v) ? v : [])
  .filter((d) => d && typeof d === 'object')
  .map((d, i) => ({
    id: str(d.id) || `dest-${i + 1}`,
    name: str(d.name) || `Destination ${i + 1}`,
    host: str(d.host),
    port: int(d.port, 1, 65535, 51001),
    enabled: bool(d.enabled, true),
  }));

/**
 * One media player and everything that follows it: the switcher input it
 * feeds, where its feedback is relayed, the NDI tally sent to it and the rules
 * that drive it. Several run at once, all on the one switcher.
 */
function normaliseDevice(d, i) {
  const player = d.player || {};
  const ndi = d.ndi || {};
  const rules = d.rules || {};
  return {
    id: ID.test(str(d.id)) ? str(d.id) : (i ? `mitti-${i + 1}` : 'mitti'),
    name: str(d.name) || (i ? `Mitti ${i + 1}` : 'Mitti'),
    player: {
      type: driverId(player.type, 'mitti'),
      settings: settingsMap(player.settings),
    },
    /* Which switcher input it feeds — what its NDI tally and rules follow. */
    input: inputSetting(d.input),
    /* Where its feedback is re-sent, for players that relay. */
    destinations: destinationList(d.destinations),
    ndi: {
      enabled: bool(ndi.enabled, false),
      source: str(ndi.source),
    },
    rules: {
      enabled: bool(rules.enabled, false),
      via: str(rules.via) || 'osc',
      onProgram: oneOf(rules.onProgram, ON_PROGRAM, 'play'),
      onPreview: oneOf(rules.onPreview, ON_PREVIEW, 'none'),
      onLeave: oneOf(rules.onLeave, ON_LEAVE, 'none'),
      onEnd: oneOf(rules.onEnd, ON_END, 'none'),
      lead: Math.min(60, Math.max(0, Number(rules.lead) || 0)),
    },
  };
}

/* Every device, ids made unique. There is always at least one. */
function deviceList(v) {
  const list = (Array.isArray(v) ? v : []).filter((d) => d && typeof d === 'object');
  const seen = new Set();
  return (list.length ? list : [{}]).map((d, i) => {
    const dev = normaliseDevice(d, i);
    let { id } = dev;
    for (let n = 2; seen.has(id); n += 1) id = `${dev.id.slice(0, 28)}-${n}`;
    seen.add(id);
    return { ...dev, id };
  });
}

export function normalise(raw = {}) {
  const r = migrate(raw && typeof raw === 'object' ? raw : {});
  const sw = r.switcher || {};
  const atem = r.atem || {};
  const display = r.display || {};
  return {
    httpPort: int(r.httpPort, 1, 65535, 8710),
    httpBind: str(r.httpBind) || '0.0.0.0',
    /* The one IPv4 address Bonjour announces (empty = every interface). */
    advertiseAddress: /^\d{1,3}(\.\d{1,3}){3}$/.test(str(r.advertiseAddress)) ? str(r.advertiseAddress) : '',
    /* The one switcher every device's input is on. */
    switcher: {
      type: driverId(sw.type, 'none'),
      settings: settingsMap(sw.settings),
    },
    atem: {
      enabled: bool(atem.enabled, false),
      name: str(atem.name) || 'automitti',
      port: int(atem.port, 1, 65535, 9910),
      advertise: bool(atem.advertise, true),
      /* The emulated ATEM's identity (Bonjour `unique id`), which is how Mitti
         recognises the same switcher next time. Stored rather than derived:
         v0.1.0 hashed the host name, and a Mac renamed by a network change
         became a different ATEM to Mitti. ConfigStore fills it in once. */
      uniqueId: /^[0-9a-f]{32}$/.test(str(atem.uniqueId)) ? str(atem.uniqueId) : '',
    },
    /* The NDI library every device's tally loads (empty = look in the usual places).
       It is loaded once per process. */
    ndi: {
      library: str(r.ndi?.library),
    },
    /* Shared by every device's clip display, each titled with its device's name. */
    display: {
      showFrames: bool(display.showFrames, false),
      warnAt: Math.max(0, Number(display.warnAt ?? 30) || 0),
      alertAt: Math.max(0, Number(display.alertAt ?? 10) || 0),
    },
    devices: deviceList(r.devices),
  };
}

export function legacyAtemId(name) {
  return crypto.createHash('md5').update(`${os.hostname()}|${name}`).digest('hex');
}

export class ConfigStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.value = normalise(this.#read());
    if (!this.value.atem.uniqueId) {
      /* First run, or a v0.1.0 file: take the id v0.1.0 would have announced on
         this machine today, so a Mitti already paired with it keeps its pairing,
         and keep it from now on whatever the machine is called. */
      this.value.atem.uniqueId = legacyAtemId(this.value.atem.name);
      try { this.set(this.value); } catch { /* read-only data dir: stays in memory */ }
    }
  }

  #read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  get() { return this.value; }

  /** Replace (after normalising) and persist atomically. */
  set(next) {
    const keepId = this.value?.atem?.uniqueId;
    this.value = normalise(next);
    /* A page that posts a config without the id must not reset it. */
    if (!this.value.atem.uniqueId && keepId) this.value.atem.uniqueId = keepId;
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    return this.value;
  }
}
