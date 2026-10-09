#!/usr/bin/env node
/*
 * The QLab driver against a real QLab: connect, read the cue list, then play,
 * pause, resume, stop and rewind, and let a clip run out — printing what the
 * driver reports at each step.
 *
 *   node tools/qlab-check.mjs --passcode 1234 [--host 127.0.0.1] [--workspace NAME]
 *                             [--types Wait] [--list NAME]
 *
 * ⚠️ It GOes the workspace. Run it against a scratch workspace, never a show.
 * Wait cues (--types Wait) make a test that plays nothing to a screen or a
 * speaker: three of them, a few seconds long, with the playhead on the first.
 */

import driver from '../drivers/players/qlab/index.js';
import { normaliseSettings } from '../server/core/contract.js';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const settings = normaliseSettings(driver.settings, {
  host: arg('host', '127.0.0.1'),
  passcode: arg('passcode'),
  workspace: arg('workspace'),
  cueList: arg('list'),
  cueTypes: arg('types', 'Video'),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const p = driver.create({ settings, log: (m) => console.log(`${stamp()} log   ${m}`) });
function stamp() { return `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`; }
const sec = (v) => (v == null ? '—' : v.toFixed(2));
function show(label) {
  const s = p.snapshot();
  console.log(`${stamp()} ${label.padEnd(18)} ${s.online ? 'online ' : 'OFFLINE'} ${s.playing ? '▶' : '‖'} `
    + `current “${s.current.name}” #${s.current.index} ${sec(s.elapsedSec)}/${sec(s.current.trtSec)} left ${sec(s.remainingSec)}`
    + ` · next “${s.next.name}” ${sec(s.next.trtSec)}${s.error ? ` · error: ${s.error}` : ''}`);
  return s;
}
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn(p.snapshot())) return true; await sleep(25); }
  return false;
}

await p.start();
const ok = await until((s) => s.online && s.cues.length && s.current.name, 8000);
const first = show('connected');
console.log(`${stamp()} summary            ${first.summary}`);
console.log(`${stamp()} cues               ${first.cues.map((c) => `${c.index}. ${c.name} (${sec(c.seconds)} s)`).join(' · ')}`);
if (!ok) { console.log('never came online with a current clip — see the error above'); await p.stop(); process.exit(1); }

await p.act('play', {});
await until((s) => s.playing, 2000);
show('play → GO');
await sleep(1000);
show('1 s later');
await p.act('pause', {});
await until((s) => !s.playing, 2000);
const paused = show('pause');
await sleep(700);
const still = show('0.7 s paused');
console.log(`${stamp()} held while paused   ${Math.abs((still.elapsedSec ?? 0) - (paused.elapsedSec ?? 0)) < 0.05 ? 'yes' : 'NO'}`);
await p.act('play', {});
await until((s) => s.playing, 2000);
show('play → resume');
await p.act('stoprewind', {});
await until((s) => !s.playing, 2000);
await sleep(300);
const rewound = show('stop + rewind');
console.log(`${stamp()} stands by on it     ${rewound.current.name === first.current.name && rewound.elapsedSec === 0 ? 'yes' : 'NO'}`);

await p.act('play', {});
await until((s) => s.playing, 2000);
show('play → GO again');
const ran = await until((s) => !s.playing, ((first.current.trtSec ?? 10) + 3) * 1000);
const end = show(ran ? 'ran out' : 'still running?');
console.log(`${stamp()} ended at 0 left     ${end.current.name === first.current.name && end.remainingSec === 0 ? 'yes' : 'NO'}`);
await sleep(2800);
show('after the hold');

await p.act('stopnext', {});
await p.stop();
process.exit(0);
