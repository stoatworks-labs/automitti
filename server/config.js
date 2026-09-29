/*
 * The settings file: one JSON document, normalised on every read so a
 * hand-edited or older file can never put the server into a shape the code
 * does not expect.
 */

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

export const SWITCHER_TYPES = ['none', 'v160hd', 'midra', 'manual'];
export const RULE_VIA = ['osc', 'hyperdeck'];
export const ON_PROGRAM = ['play', 'none'];
export const ON_PREVIEW = ['none', 'rewind'];
export const ON_LEAVE = ['none', 'pause', 'rewind', 'next'];
export const ON_END = ['none', 'cut', 'auto'];

export function normalise(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const m = r.mitti || {};
  const sw = r.switcher || {};
  const atem = r.atem || {};
  const ndi = r.ndi || {};
  const rules = r.rules || {};
  const display = r.display || {};
  const destinations = (Array.isArray(r.destinations) ? r.destinations : [])
    .filter((d) => d && typeof d === 'object')
    .map((d, i) => ({
      id: str(d.id) || `dest-${i + 1}`,
      name: str(d.name) || `Destination ${i + 1}`,
      host: str(d.host),
      port: int(d.port, 1, 65535, 51001),
      enabled: bool(d.enabled, true),
    }));
  return {
    httpPort: int(r.httpPort, 1, 65535, 8710),
    httpBind: str(r.httpBind) || '0.0.0.0',
    /* The one IPv4 address Bonjour announces (empty = every interface). */
    advertiseAddress: /^\d{1,3}(\.\d{1,3}){3}$/.test(str(r.advertiseAddress)) ? str(r.advertiseAddress) : '',
    mitti: {
      host: str(m.host, '127.0.0.1'),
      oscPort: int(m.oscPort, 1, 65535, 51000),
      feedbackPort: int(m.feedbackPort, 0, 65535, 51010), // 0 = any free port (tests),
      advertise: bool(m.advertise, true),
      hyperdeck: bool(m.hyperdeck, true),
      hyperdeckPort: int(m.hyperdeckPort, 1, 65535, 9993),
    },
    destinations,
    switcher: {
      type: oneOf(sw.type, SWITCHER_TYPES, 'none'),
      host: str(sw.host),
      port: int(sw.port, 0, 65535, 0), // 0 = the driver's default
      password: str(sw.password),
      /* Which switcher input Mitti feeds — what NDI tally and the rules follow. */
      mittiInput: str(sw.mittiInput),
      /* Midra 4K / Pulse: the screens that count as "on air"; empty = all. */
      screens: Array.isArray(sw.screens) ? sw.screens.map(String).filter(Boolean) : [],
      /* Midra 4K / Pulse: the layer Mitti's input is put on for a preview/program select. */
      layer: int(sw.layer, 1, 8, 1),
    },
    atem: {
      enabled: bool(atem.enabled, false),
      name: str(atem.name) || 'automitti',
      port: int(atem.port, 1, 65535, 9910),
      advertise: bool(atem.advertise, true),
    },
    ndi: {
      enabled: bool(ndi.enabled, false),
      source: str(ndi.source),
      library: str(ndi.library),
    },
    rules: {
      enabled: bool(rules.enabled, false),
      via: oneOf(rules.via, RULE_VIA, 'osc'),
      onProgram: oneOf(rules.onProgram, ON_PROGRAM, 'play'),
      onPreview: oneOf(rules.onPreview, ON_PREVIEW, 'none'),
      onLeave: oneOf(rules.onLeave, ON_LEAVE, 'none'),
      onEnd: oneOf(rules.onEnd, ON_END, 'none'),
      lead: Math.min(60, Math.max(0, Number(rules.lead) || 0)),
    },
    display: {
      title: str(display.title),
      showFrames: bool(display.showFrames, false),
      warnAt: Math.max(0, Number(display.warnAt ?? 30) || 0),
      alertAt: Math.max(0, Number(display.alertAt ?? 10) || 0),
    },
  };
}

export class ConfigStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.value = normalise(this.#read());
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
    this.value = normalise(next);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
    return this.value;
  }
}
