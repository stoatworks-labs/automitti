/*
 * The driver contract. docs/DRIVERS.md is the prose version of this file;
 * this is the one the code checks.
 *
 * A driver is a folder whose index.js default-exports a DESCRIPTOR:
 *
 *   {
 *     api: 1,                          the contract version it was written for
 *     kind: 'switcher' | 'player',
 *     id: 'v160hd',                    lower-case, unique within its kind
 *     label: 'Roland V-160HD',
 *     description: '…',                one sentence, shown under the picker
 *     help: '…',                       optional, shown under its settings
 *     settings: [ field, … ],          what the settings page asks for
 *     create({ settings, log, … }),    returns the driver INSTANCE
 *     testRig?: async () => ({ settings, close }),   a simulator for the contract tests
 *     …kind-specific fields below
 *   }
 *
 * A settings field:
 *
 *   { key, label, type: 'text'|'password'|'number'|'bool'|'select'|'list',
 *     default?, placeholder?, help?, required?, min?, max?, options?: [{value,label}],
 *     unique? }
 *
 * `list` is a comma-separated list of strings. The host normalises what a
 * driver receives against this schema, so a driver can trust its settings.
 *
 * A player driver runs once per DEVICE, several at a time, so it must keep no
 * state at module level. `unique: true` marks a setting each of its devices
 * needs its own value of — a port it listens on. A new device gets one past
 * the highest its devices use (the default for the first), and two devices
 * sharing one are flagged. Empty and 0 are exempt.
 */

export const API_VERSION = 1;
export const KINDS = ['switcher', 'player'];

/* ------------------------------------------------------------ switchers */

/**
 * A SWITCHER instance is an EventEmitter with:
 *
 *   connect()            start (and keep) the connection
 *   close()              stop for good
 *   cut() auto()         → Promise
 *   setPreview(id)       → Promise
 *   setProgram(id)       → Promise
 *   capabilities?()      → { cut, auto, preview, program } (defaults all true)
 *
 * and emits:
 *
 *   'status' (status, error?)   'connecting' | 'online' | 'offline'
 *   'state'  (patch)            any of:
 *        inputs        [{ id, name, short }]  id = the switcher's own input number
 *        program       id | null              the main program source
 *        preview       id | null
 *        tally         { [id]: { program, preview } }   everything on air — on a layer
 *                      switcher several inputs at once; during a transition, both sides
 *        inTransition  boolean
 *        device        { model, version? }
 *
 * A driver that never sends `tally` gets it derived from program/preview.
 *
 * Switcher descriptor extras:
 *   inputCount: number | (settings) => number
 *       How many inputs the emulated ATEM carries. Topology to an ATEM client:
 *       it must not change while connected, so it is fixed per driver (and
 *       settings), not read from the device.
 */
export const SWITCHER_METHODS = ['connect', 'close', 'cut', 'auto', 'setPreview', 'setProgram'];

/* ------------------------------------------------------------ players */

/**
 * A PLAYER instance is an EventEmitter with:
 *
 *   start()              → Promise; open links (a taken port must not throw — report it)
 *   stop()
 *   snapshot()           → PlaybackState (below)
 *   act(action, { via }) → Promise; action is one of PLAYER_ACTIONS
 *   command?(address, args)   raw pass-through for the player's own protocol
 *   bonjour?()           → [{ key, name, type, protocol, port, txt? }] to announce
 *
 * and emits 'change' whenever the snapshot may differ.
 *
 * PlaybackState — everything the clip display, the rules and the status page read:
 *
 *   {
 *     online: boolean,          error: string | null,
 *     playing: boolean,         playhead: 0–1 within the current clip,
 *     fps: number,              updatedAt: ms timestamp of the last feedback,
 *     current:  { name, index, trtSec },
 *     next:     { name, index, trtSec },
 *     elapsedSec, remainingSec: number | null,
 *     cues: [{ index, name, seconds }],
 *     summary: string,          one line for the status card ("OSC online · 4 clips")
 *     detail: { … }             anything driver-specific, shown to nobody but the curious
 *   }
 *
 * Player descriptor extras:
 *   via:          [{ value, label }]   transports the rules may use ('osc', 'hyperdeck', …)
 *   relay:        true if the player's feedback can be re-sent to destinations
 *   integrations: ['atem', 'ndi']      which of the core's switcher emulations it can follow
 */
export const PLAYER_ACTIONS = ['play', 'pause', 'rewind', 'next', 'prev', 'stoprewind', 'stopnext'];
export const PLAYER_METHODS = ['start', 'stop', 'snapshot', 'act'];

/* ------------------------------------------------------------ validation */

const FIELD_TYPES = ['text', 'password', 'number', 'bool', 'select', 'list'];
const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Problems with a descriptor, as sentences; empty means it is usable. */
export function checkDescriptor(d, expectKind) {
  const bad = [];
  if (!d || typeof d !== 'object') return ['index.js does not default-export a descriptor object'];
  if (d.api !== API_VERSION) bad.push(`api is ${JSON.stringify(d.api)}, this automitti speaks ${API_VERSION}`);
  if (!KINDS.includes(d.kind)) bad.push(`kind must be one of ${KINDS.join(', ')}`);
  if (expectKind && d.kind !== expectKind) bad.push(`is a ${d.kind} driver in the ${expectKind}s folder`);
  if (!ID.test(String(d.id ?? ''))) bad.push('id must be lower-case letters, digits and dashes');
  if (!d.label) bad.push('label is missing');
  if (typeof d.create !== 'function') bad.push('create() is missing');
  if (!Array.isArray(d.settings)) bad.push('settings must be an array (it may be empty)');
  else {
    const keys = new Set();
    for (const f of d.settings) {
      if (!f || !f.key || !f.label) { bad.push('every setting needs a key and a label'); continue; }
      if (keys.has(f.key)) bad.push(`setting "${f.key}" appears twice`);
      keys.add(f.key);
      if (!FIELD_TYPES.includes(f.type)) bad.push(`setting "${f.key}" has unknown type "${f.type}"`);
      if (f.type === 'select' && !Array.isArray(f.options)) bad.push(`select "${f.key}" needs options`);
    }
  }
  if (d.kind === 'switcher' && d.inputCount == null) bad.push('a switcher needs inputCount');
  return bad;
}

/** Problems with an instance's shape (after create()). */
export function checkInstance(inst, kind) {
  const need = kind === 'switcher' ? SWITCHER_METHODS : PLAYER_METHODS;
  const missing = need.filter((m) => typeof inst?.[m] !== 'function');
  if (typeof inst?.on !== 'function') missing.push('on (it must be an EventEmitter)');
  return missing.length ? [`missing ${missing.join(', ')}`] : [];
}

/** A driver's settings, made to match its schema: defaults filled, types coerced, ranges clamped. */
export function normaliseSettings(schema, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const f of schema || []) {
    const v = r[f.key];
    switch (f.type) {
      case 'number': {
        const n = Number(v);
        const ok = v !== '' && v != null && Number.isFinite(n)
          && (f.min == null || n >= f.min) && (f.max == null || n <= f.max);
        out[f.key] = ok ? n : (f.default ?? null);
        break;
      }
      case 'bool': out[f.key] = typeof v === 'boolean' ? v : (f.default ?? false); break;
      case 'select': {
        const values = f.options.map((o) => o.value);
        out[f.key] = values.includes(v) ? v : (f.default ?? values[0]);
        break;
      }
      case 'list': {
        const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : (f.default ?? []);
        out[f.key] = list.map((x) => String(x).trim()).filter(Boolean);
        break;
      }
      default: out[f.key] = typeof v === 'string' ? v.trim() : (f.default ?? '');
    }
  }
  return out;
}

/** What the settings page needs to know about a driver: no functions. */
export function describe(d, source) {
  return {
    id: d.id,
    kind: d.kind,
    label: d.label,
    description: d.description || '',
    help: d.help || '',
    settings: d.settings,
    via: d.via || [],
    relay: !!d.relay,
    integrations: d.integrations || [],
    source,
  };
}
