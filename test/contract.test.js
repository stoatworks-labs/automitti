/*
 * The driver contract, held against every driver automitti can find — the
 * built-in ones, and any in AUTOMITTI_DRIVERS (a folder laid out like
 * drivers/), which is how a community driver runs the same suite:
 *
 *   AUTOMITTI_DRIVERS=~/my-drivers npm test
 *
 * A driver with a `testRig` (a simulator of its device) is also driven:
 * switchers connect, list inputs, take a preview and a cut; players come
 * online, play, and pause. A driver without one is only checked for shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry, BUILTIN } from '../server/core/registry.js';
import { checkInstance, normaliseSettings, describe } from '../server/core/contract.js';
import { lib } from '../server/lib/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(20); }
  return false;
}

const roots = [BUILTIN, ...(process.env.AUTOMITTI_DRIVERS ? [process.env.AUTOMITTI_DRIVERS] : [])];
const registry = await Registry.load(roots);

test('every driver folder loads and passes the contract', () => {
  assert.deepEqual(registry.problems, []);
  assert.ok(registry.switcher('v160hd') && registry.switcher('midra') && registry.switcher('manual'));
  assert.ok(registry.player('mitti'));
  for (const d of [...registry.switchers.values(), ...registry.players.values()]) {
    const shown = describe(d, 'built-in');
    assert.equal(JSON.parse(JSON.stringify(shown)).id, d.id, `${d.id} describes itself as plain data`);
    const s = normaliseSettings(d.settings, {});
    for (const f of d.settings) assert.ok(f.key in s, `${d.id}.${f.key} gets a default`);
  }
});

for (const d of registry.switchers.values()) {
  test(`switcher "${d.id}" against its rig`, { skip: !d.testRig && 'no test rig' }, async (t) => {
    const rig = await d.testRig();
    if (!rig) return t.skip('its rig is not available here (see the driver\'s index.js)');
    const inst = d.create({ settings: normaliseSettings(d.settings, rig.settings), log: () => {}, lib });
    assert.deepEqual(checkInstance(inst, 'switcher'), []);
    const model = { tally: {} };
    let status = null;
    inst.on('status', (s) => { status = s; });
    inst.on('state', (p) => Object.assign(model, p));
    try {
      inst.connect();
      assert.ok(await until(() => status === 'online'), 'comes online');
      assert.ok(await until(() => model.inputs?.length > 1), 'lists inputs');
      for (const i of model.inputs) assert.ok(Number.isInteger(i.id) && typeof i.name === 'string', 'inputs are {id, name}');
      const count = typeof d.inputCount === 'function' ? d.inputCount(normaliseSettings(d.settings, rig.settings)) : d.inputCount;
      assert.ok(model.inputs.length <= count, 'no more inputs than the emulated ATEM will carry');
      const target = model.inputs.find((i) => i.id !== model.program)?.id ?? model.inputs[1].id;
      await inst.setPreview(target);
      assert.ok(await until(() => model.preview === target), 'preview select lands');
      await inst.cut();
      assert.ok(await until(() => model.program === target), 'a cut puts it on program');
    } finally {
      inst.close();
      await rig.close();
    }
  });
}

for (const d of registry.players.values()) {
  test(`player "${d.id}" against its rig`, { skip: !d.testRig && 'no test rig' }, async () => {
    const rig = await d.testRig();
    const inst = d.create({ settings: normaliseSettings(d.settings, rig.settings), log: () => {}, lib, destinations: () => [] });
    assert.deepEqual(checkInstance(inst, 'player'), []);
    try {
      await inst.start();
      rig.attach?.(inst);
      assert.ok(await until(() => inst.snapshot().online), 'comes online');
      const s = inst.snapshot();
      for (const k of ['playing', 'current', 'next', 'cues', 'fps']) assert.ok(k in s, `snapshot has ${k}`);
      await inst.act('play', {});
      assert.ok(await until(() => inst.snapshot().playing), 'play plays');
      assert.ok(await until(() => inst.snapshot().current.name), 'reports the current clip');
      await inst.act('pause', {});
      assert.ok(await until(() => !inst.snapshot().playing), 'pause pauses');
    } finally {
      await inst.stop();
      await rig.close();
    }
  });
}
