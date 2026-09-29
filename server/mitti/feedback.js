/*
 * Mitti's OSC feedback vocabulary (2.8.18, read from the binary — see
 * docs/MITTI.md) folded into one playback state object. Pure: no sockets, so
 * the tests and the simulator share it.
 *
 * Mitti sends only the value-carrying form of each address, and echoes every
 * cue-level value both as `/mitti/<n>/…` and `/mitti/current/…`.
 */

export function emptyPlayback() {
  return {
    playing: false,
    playhead: 0,              // 0–1 within the current cue
    time: null,               // playlist time string, as sent
    elapsed: null,            // current cue elapsed, 'hh:mm:ss:ff'
    remaining: null,          // current cue time left, 'hh:mm:ss:ff'
    current: { id: null, name: null, trt: null },
    next: { name: null },
    previous: { name: null },
    selected: { id: null, name: null },
    videoOutputs: null,
    cues: {},                 // index (1-based, as a string) → { name, deleted? }
    fps: null,                // inferred from the highest frame field seen
    maxFrame: 0,
  };
}

const first = (args) => (args && args.length ? args[0] : undefined);
/* Mitti sends "-" for a name that does not exist (an empty playlist, no next cue). */
const str = (v) => (v == null || v === '-' || v === '' ? null : String(v));
const TC = /^(-)?(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{1,3})$/;

/** 'hh:mm:ss:ff' → { h, m, s, f, neg } or null. */
export function parseTc(s) {
  const m = TC.exec(String(s ?? '').trim());
  if (!m) return null;
  return { neg: !!m[1], h: +m[2], m: +m[3], s: +m[4], f: +m[5] };
}

/** Seconds from a timecode string at `fps`; null when it will not parse. */
export function tcToSeconds(s, fps = 25) {
  const t = parseTc(s);
  if (!t) return null;
  const v = t.h * 3600 + t.m * 60 + t.s + t.f / (fps || 25);
  return t.neg ? -v : v;
}

/* The nominal rates a frame field can top out at. 23 → 24, 24 → 25, 29 → 30… */
const RATES = [24, 25, 30, 48, 50, 60];
function inferFps(maxFrame) {
  return RATES.find((r) => maxFrame < r) ?? 60;
}

/**
 * Apply one decoded message. Returns true if anything a display cares about
 * changed, so the caller can decide whether to publish.
 */
export function applyFeedback(state, { address, args }) {
  if (!address.startsWith('/mitti/')) return false;
  const path = address.slice(7).split('/');
  const v = first(args);

  if (path.length === 1) {
    switch (path[0]) {
      case 'togglePlay': state.playing = Number(v) === 1 || v === true; return true;
      case 'playhead': state.playhead = clamp01(Number(v)); return true;
      case 'time': state.time = str(v); return true;
      case 'cueTimeElapsed': noteTc(state, v); state.elapsed = str(v); return true;
      /* Mitti sends time left as a NEGATIVE timecode ("-00:00:45:00"). */
      case 'cueTimeLeft': noteTc(state, v); state.remaining = str(v)?.replace(/^-/, '') ?? null; return true;
      case 'currentCueName': state.current.name = str(v); return true;
      case 'currentCueID': state.current.id = str(v); return true;
      case 'currentCueTRT': noteTc(state, v); state.current.trt = str(v); return true;
      case 'nextCueName': state.next.name = str(v); return true;
      case 'previousCueName': state.previous.name = str(v); return true;
      case 'selectedCueName': state.selected.name = str(v); return true;
      case 'selectedCueID': state.selected.id = str(v); return true;
      case 'toggleVideoOutputs': state.videoOutputs = Number(v) === 1; return true;
      default: return false;
    }
  }

  if (path.length === 2 && /^\d+$/.test(path[0])) {
    const key = String(Number(path[0]));
    if (path[1] === 'cueName') {
      state.cues[key] = { ...(state.cues[key] || {}), name: str(v) };
      delete state.cues[key].deleted;
      return true;
    }
    if (path[1] === 'deleted') {
      delete state.cues[key];
      return true;
    }
  }
  return false;
}

function noteTc(state, v) {
  const t = parseTc(v);
  if (t && t.f > state.maxFrame) {
    state.maxFrame = t.f;
    state.fps = inferFps(t.f);
  }
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** The playlist in order, as `[{ index, name }]`. */
export function cueList(state) {
  return Object.entries(state.cues)
    .map(([k, c]) => ({ index: Number(k), name: c.name }))
    .sort((a, b) => a.index - b.index);
}
