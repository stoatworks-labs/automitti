/*
 * The QLab driver against its simulator (drivers/players/qlab/sim.mjs), whose
 * behaviour was taken from a real QLab 5.5.10 — docs/QLAB.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import driver from '../drivers/players/qlab/index.js';
import { startQLabSim } from '../drivers/players/qlab/sim.mjs';
import { normaliseSettings } from '../server/core/contract.js';
import { Registry } from '../server/core/registry.js';
import { Player } from '../server/core/player.js';
import { Switcher } from '../server/core/switcher.js';
import { Rules } from '../server/rules.js';
import { normalise } from '../server/config.js';

const registry = await Registry.load();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

async function rig(simOptions = {}, settings = {}) {
  const sim = await startQLabSim({ port: 0, ...simOptions });
  const player = driver.create({
    settings: normaliseSettings(driver.settings, { host: '127.0.0.1', port: sim.port, passcode: sim.passcode, ...settings }),
    log: () => {},
  });
  await player.start();
  return {
    sim,
    player,
    snap: () => player.snapshot(),
    sent: (address) => sim.state.received.filter((m) => m.address.endsWith(address)).length,
    async close() { await player.stop(); await sim.close(); },
  };
}

test('QLab: joins with the passcode, lists only the clips, stands by on the playhead', async () => {
  const r = await rig();
  try {
    assert.ok(await until(() => r.snap().online && r.snap().cues.every((c) => c.seconds != null) && r.snap().current.name));
    const s = r.snap();
    assert.deepEqual(s.cues.map((c) => [c.index, c.name, c.seconds]), [
      [1, 'Walk-in loop', 30], [2, 'Opener', 12], [3, 'Sponsor reel', 20], [4, 'Award VT 1', 45],
    ], 'the Light and Audio cues are passed over');
    assert.equal(s.current.name, 'Walk-in loop');
    assert.equal(s.current.trtSec, 30);
    assert.equal(s.remainingSec, 30);
    assert.equal(s.playing, false);
    assert.equal(s.next.name, 'Opener', 'the Light cue between them is skipped');
    assert.match(s.summary, /“Show” · connected · Main Cue List · 4 video cues/);
    assert.deepEqual(s.detail.permissions, ['view', 'edit', 'control']);
  } finally {
    await r.close();
  }
});

test('QLab: play GOes once; pause holds; play again resumes rather than GOing the next cue', async () => {
  const r = await rig();
  try {
    await until(() => r.snap().online && r.snap().current.name);
    await r.player.act('play', {});
    await r.player.act('play', {}); // before the first GO's clip has been seen: a double GO
    assert.ok(await until(() => r.snap().playing), 'plays');
    assert.equal(r.sim.cue('Walk-in loop').run, 'running');
    assert.equal(r.sim.state.playhead, r.sim.cue('House to half').id, 'GO moved the playhead on');
    assert.ok(await until(() => r.snap().next.name === 'Opener'));
    assert.equal(r.snap().current.name, 'Walk-in loop');

    await r.player.act('play', {});
    await sleep(150);
    assert.equal(r.sent('/go'), 1, 'no second GO while a clip runs');

    await r.player.act('pause', {});
    assert.ok(await until(() => !r.snap().playing && r.sim.cue('Walk-in loop').run === 'paused'));
    const held = r.snap().elapsedSec;
    await sleep(300);
    assert.ok(Math.abs(r.snap().elapsedSec - held) < 0.05, 'a paused clip holds its time');

    await r.player.act('play', {});
    assert.ok(await until(() => r.snap().playing && r.sim.cue('Walk-in loop').run === 'running'), 'resumed');
    assert.equal(r.sent('/go'), 1, 'resumed, not GOne');
    assert.equal(r.sim.cue('House to half').run, 'idle', 'the next cue was not fired');
  } finally {
    await r.close();
  }
});

test('QLab: stop-and-rewind stands by on the clip again; stop-and-next leaves the playhead where GO put it', async () => {
  const r = await rig();
  try {
    await until(() => r.snap().online && r.snap().current.name);
    await r.player.act('play', {});
    await until(() => r.snap().playing);
    await r.player.act('stoprewind', {});
    assert.ok(await until(() => !r.snap().playing && r.sim.cue('Walk-in loop').run === 'idle'));
    assert.equal(r.sim.state.playhead, r.sim.cue('Walk-in loop').id);
    assert.ok(await until(() => r.snap().current.name === 'Walk-in loop' && r.snap().elapsedSec === 0 && r.snap().remainingSec === 30));

    await r.player.act('play', {});
    await until(() => r.snap().playing);
    await r.player.act('stopnext', {});
    assert.ok(await until(() => !r.snap().playing));
    assert.equal(r.sim.state.playhead, r.sim.cue('House to half').id, 'not moved again');
    assert.ok(await until(() => r.snap().current.name === 'Opener'), 'the next clip stands by');

    await r.player.act('next', {});
    assert.ok(await until(() => r.sim.state.playhead === r.sim.cue('Opener').id));
    await r.player.act('prev', {});
    assert.ok(await until(() => r.sim.state.playhead === r.sim.cue('House to half').id));
  } finally {
    await r.close();
  }
});

test('QLab: a clip that runs out stays current at 0 left for the rules, then the next one stands by', async () => {
  const r = await rig({ cues: [
    { number: '1', name: 'Short', type: 'Video', seconds: 0.8 },
    { number: '2', name: 'Long', type: 'Video', seconds: 30 },
  ] });
  try {
    await until(() => r.snap().online && r.snap().current.name);
    await r.player.act('play', {});
    assert.ok(await until(() => r.snap().playing));
    assert.ok(await until(() => !r.snap().playing, 2000), 'ran out');
    let s = r.snap();
    assert.equal(s.current.name, 'Short');
    assert.equal(s.remainingSec, 0);
    assert.equal(s.elapsedSec, 0.8);
    await sleep(1500);
    assert.equal(r.snap().current.name, 'Short', 'still held');
    assert.ok(await until(() => r.snap().current.name === 'Long', 2000));
    s = r.snap();
    assert.equal(s.remainingSec, 30);
    assert.equal(s.playing, false);
  } finally {
    await r.close();
  }
});

test('QLab: a stopped clip is not mistaken for one that ran out', async () => {
  const r = await rig();
  try {
    await until(() => r.snap().online && r.snap().current.name);
    await r.player.act('play', {});
    await until(() => r.snap().playing);
    r.player.command(`/cue_id/${r.sim.cue('Walk-in loop').id}/stop`);
    assert.ok(await until(() => !r.snap().playing));
    assert.notEqual(r.snap().remainingSec, 0);
    assert.equal(r.snap().current.name, 'Opener', 'nothing held: the next clip stands by');
  } finally {
    await r.close();
  }
});

test('QLab: a wrong passcode is reported and not tried again straight away', async () => {
  const r = await rig({}, { passcode: '0000' });
  try {
    assert.ok(await until(() => /refused the passcode for “Show”/.test(r.snap().error || '')));
    await sleep(1200);
    assert.equal(r.sent('/connect'), 1, 'QLab locks out a passcode guesser: one try, then a long wait');
    assert.equal(r.snap().online, false);
  } finally {
    await r.close();
  }
});

test('QLab: no passcode, on a workspace that gives passcode-less connections nothing', async () => {
  const r = await rig({}, { passcode: '' });
  try {
    assert.ok(await until(() => /without a passcode no access/.test(r.snap().error || '')));
    assert.equal(r.snap().online, false);
  } finally {
    await r.close();
  }
});

test('QLab: a passcode that can only view says the rules cannot drive it', async () => {
  const r = await rig({ permissions: 'view' });
  try {
    assert.ok(await until(() => r.snap().online));
    assert.match(r.snap().error, /can't control it/);
    assert.ok(await until(() => r.snap().current.name === 'Walk-in loop'), 'still shows the clips');
  } finally {
    await r.close();
  }
});

test('QLab: a workspace is found by name; a missing one is reported with the ones that are open', async () => {
  const named = await rig({ name: 'Gala' }, { workspace: 'gala.qlab5' });
  try {
    assert.ok(await until(() => named.snap().online));
  } finally {
    await named.close();
  }
  const missing = await rig({ name: 'Gala' }, { workspace: 'Rehearsal' });
  try {
    assert.ok(await until(() => /no workspace called “Rehearsal” open \(open: Gala\)/.test(missing.snap().error || '')));
  } finally {
    await missing.close();
  }
});

test('QLab: a closed workspace and a dropped connection are both come back from', async () => {
  const r = await rig();
  try {
    await until(() => r.snap().online && r.snap().current.name);
    await r.player.act('play', {});
    await until(() => r.snap().playing);
    r.sim.closeWorkspace();
    assert.ok(await until(() => !r.snap().online && !r.snap().playing), 'not still playing a closed workspace');
    assert.equal(r.snap().current.name, null, 'nor showing its clips');
    assert.deepEqual(r.snap().cues, []);
    assert.ok(await until(() => /no workspace open/.test(r.snap().error || ''), 4000));
    r.sim.openWorkspace();
    assert.ok(await until(() => r.snap().online, 4000), 'joins again when it reopens');
    r.sim.dropClients();
    assert.ok(await until(() => !r.snap().online));
    assert.ok(await until(() => r.snap().online, 4000), 'reconnects');
    assert.equal(r.snap().current.name, 'Walk-in loop');
  } finally {
    await r.close();
  }
});

test('QLab: raw commands go to the joined workspace, application messages stay unprefixed', async () => {
  const r = await rig();
  try {
    await until(() => r.snap().online);
    const ws = r.sim.state.workspace.id;
    r.player.command('/go');
    r.player.command('/alwaysReply', [0]);
    await until(() => r.sent('/alwaysReply') === 1);
    assert.ok(r.sim.state.received.some((m) => m.address === `/workspace/${ws}/go`));
    assert.ok(r.sim.state.received.some((m) => m.address === '/alwaysReply'));
  } finally {
    await r.close();
  }
});

test('rules with QLab: GO on program, AUTO at the clip end, stop off air — manual switcher, through the hosts', async () => {
  const sim = await startQLabSim({ port: 0, cues: [
    { number: '1', name: 'VT', type: 'Video', seconds: 1.2 },
    { number: '2', name: 'Next VT', type: 'Video', seconds: 30 },
  ] });
  const cfg = normalise({
    switcher: { type: 'manual', settings: { manual: { inputs: 8 } } },
    devices: [{
      player: { type: 'qlab', settings: { qlab: { host: '127.0.0.1', port: sim.port, passcode: sim.passcode } } },
      input: '5',
      rules: { enabled: true, onProgram: 'play', onLeave: 'next', onEnd: 'auto' },
    }],
  });
  const device = () => cfg.devices[0];
  const player = new Player({ config: device, registry });
  await player.start();
  const switcher = new Switcher({ config: () => cfg, registry });
  await switcher.start();
  const rules = new Rules({ config: device, switcher, player });
  const did = [];
  rules.on('change', () => { const w = rules.snapshot().last?.what; if (w && did.at(-1) !== w) did.push(w); });
  rules.start();
  try {
    assert.ok(await until(() => player.snapshot().online && player.snapshot().current.name === 'VT'));
    await switcher.command('program', 1);
    await switcher.command('preview', 5);
    await switcher.command('auto');
    assert.ok(await until(() => sim.cue('VT').run === 'running'), 'rolled on program');
    /* The clip runs out → the rule AUTOs away → QLab is off air → "next" (already where GO left it). */
    assert.ok(await until(() => switcher.model.program === 1, 4000), 'took away at the end');
    assert.ok(await until(() => did.includes('taken off → next') && did.includes('cue ended → auto')));
    /* The manual switcher takes at once, so "taken off" can be logged before the AUTO that caused it. */
    assert.deepEqual(did.slice(1).sort(), ['cue ended → auto', 'taken off → next']);
    assert.equal(did[0], 'on program → play');
    assert.equal(sim.cue('Next VT').run, 'idle', 'the next clip was not fired');
    assert.equal(sim.state.playhead, sim.cue('Next VT').id, 'and stands by');
  } finally {
    rules.stop();
    switcher.stop();
    await player.stop();
    await sim.close();
  }
});
