/*
 * Analog Way's mnemonic protocol (TCP 10500) and the two drivers on it,
 * LiveCore and Midra, against the simulator — which plays back what openRCS
 * found on a real NeXtage 16 and Pulse².
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../server/lib/analogway.js';
import { LiveCoreDriver } from '../drivers/switchers/livecore/driver.js';
import { MidraClassicDriver } from '../drivers/switchers/midra-classic/driver.js';
import { startAwSim } from '../drivers/switchers/livecore/sim.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(10); }
  return false;
}

/** A driver, its sim, and the model the host would keep. */
async function rig(Driver, family, opts = {}, simOpts = {}) {
  const sim = await startAwSim({ family, port: 0, ...simOpts });
  const d = new Driver({ host: '127.0.0.1', port: sim.port, ...opts });
  const r = { sim, d, model: { tally: {} }, status: null, error: null, states: [] };
  d.on('status', (s, e) => { r.status = s; r.error = e; });
  d.on('state', (p) => { Object.assign(r.model, p); r.states.push(structuredClone(p)); });
  d.connect();
  r.close = async () => { d.close(); await sim.close(); };
  return r;
}

test('the framing: mnemonic last going out, first coming back', () => {
  assert.equal(encode('PRinp', [0, 1, 1], 5), '0,1,1,5PRinp');
  assert.equal(encode('PRinp', [0, 1, 1]), '0,1,1,PRinp');
  assert.equal(encode('GCtal', [], 1), '1GCtal');
  assert.equal(encode('GCtal'), 'GCtal');
  assert.deepEqual(decode('PRinp0,1,1,5'), { mnem: 'PRinp', idx: [0, 1, 1], value: 5 });
  assert.deepEqual(decode('IEbri-50'), { mnem: 'IEbri', idx: [], value: -50 });
  assert.deepEqual(decode('DEV259'), { mnem: 'DEV', idx: [], value: 259 });
  assert.deepEqual(decode('E10'), { error: 10 });
  assert.equal(decode(''), null);
});

test('LiveCore: model, labels as input names, and preset-update mode kept on', async () => {
  const r = await rig(LiveCoreDriver, 'livecore', {}, { pmu: 0 });
  try {
    assert.ok(await until(() => r.status === 'online'));
    assert.equal(r.model.device.model, 'NeXtage 16');
    assert.ok(await until(() => r.model.inputs?.[2]?.name === 'MITTI'), 'labels read');
    assert.equal(r.model.inputs.length, 8, 'only fitted inputs');
    assert.ok(await until(() => r.sim.get('CTpmu') === 1), 'switched to preset-update mode');
    assert.deepEqual([r.model.program, r.model.preview], [1, 2]);
  } finally { await r.close(); }
});

test('LiveCore: a select is held until GROUP_UPDATE, and lands with it', async () => {
  const r = await rig(LiveCoreDriver, 'livecore', {}, { pmu: 1 });
  try {
    assert.ok(await until(() => r.status === 'online'));
    await r.d.setPreview(3);
    assert.ok(await until(() => r.model.preview === 3 && r.model.tally[3]?.preview));
    assert.ok(r.sim.state.log.includes('1GCupd'));
    assert.deepEqual([r.sim.get('PRinp', 0, 1, 0), r.sim.get('PRinp', 1, 1, 0)], [3, 3], 'PB on both screens');
    assert.equal(r.sim.get('PRinp', 0, 0, 0), 1, 'the bank on air untouched');
  } finally { await r.close(); }
});

test('LiveCore: AUTO sweeps the T-bar, and both banks are on air while it runs', async () => {
  const r = await rig(LiveCoreDriver, 'livecore', { takeMs: 400 });
  try {
    assert.ok(await until(() => r.status === 'online'));
    await r.d.setPreview(3);
    await until(() => r.model.preview === 3);
    r.states.length = 0;
    await r.d.auto();
    assert.ok(await until(() => r.model.inTransition && r.model.tally[3]?.program && r.model.tally[1]?.program), 'both on air mid-take');
    assert.ok(await until(() => r.sim.get('GCsta', 0) === 1 && !r.model.inTransition), 'landed on PB');
    assert.ok(await until(() => r.model.program === 3 && !r.model.tally[1]?.program && r.model.tally[1]?.preview));
    const bars = r.sim.state.log.filter((l) => /^0,\d+GCtba$/.test(l)).map((l) => Number(l.split(',')[1].replace('GCtba', '')));
    assert.ok(bars.length > 3 && bars.at(-1) === 65535, `swept, not jumped (${bars.length} steps)`);
    assert.ok(!r.sim.state.log.some((l) => /GCtk[ud]$/.test(l)), 'never the stalling take verbs');
    await r.d.cut();
    assert.ok(await until(() => r.sim.get('GCsta', 0) === 0 && r.model.program === 1), 'a cut jumps back to PA');
  } finally { await r.close(); }
});

test('Midra: preset-update mode is turned off, and the take lands with both sides on air', async () => {
  const r = await rig(MidraClassicDriver, 'midra', {}, { pmu: 1, takeMs: 400 });
  try {
    assert.ok(await until(() => r.status === 'online'));
    assert.equal(r.model.device.model, 'Pulse²');
    assert.deepEqual(r.model.inputs.slice(4, 7).map((i) => i.name), ['HDMI 1', 'HDMI 2', 'SDI 1'], 'the Pulse² names');
    assert.deepEqual([r.model.program, r.model.preview], [1, 2]);
    await r.d.auto();
    assert.ok(await until(() => r.model.inTransition && r.model.tally[1]?.program && r.model.tally[2]?.program), 'both on air mid-take');
    assert.ok(await until(() => r.model.program === 2 && !r.model.inTransition && !r.model.tally[1]?.program), 'landed');
    const log = r.sim.state.log;
    assert.ok(log.indexOf('0CTpmu') >= 0 && log.indexOf('0CTpmu') < log.indexOf('0,0GCtak'), 'preset-update mode off before the take');
    assert.ok(log.indexOf('0,0GCtak') < log.indexOf('0,1GCtak'), 'pulsed 0 then 1');
  } finally { await r.close(); }
});

test('Midra: CUT moves the T-bar through the middle, and an input with no signal is refused aloud', async () => {
  const r = await rig(MidraClassicDriver, 'midra', { names: ['Mitti', 'Camera'] }, { pmu: 0 });
  try {
    assert.ok(await until(() => r.status === 'online'));
    assert.deepEqual(r.model.inputs.slice(0, 3).map((i) => i.name), ['Mitti', 'Camera', 'Input 3'], 'names from the settings first');
    await r.d.cut();
    assert.ok(await until(() => r.model.program === 2));
    const log = r.sim.state.log.filter((l) => l.endsWith('GCtba') && l.includes(',') && !l.endsWith(',GCtba'));
    assert.deepEqual(log.slice(0, 2), ['0,5000GCtba', '1,5000GCtba']);
    assert.deepEqual(log.slice(2, 4), ['0,10000GCtba', '1,10000GCtba']);
    await assert.rejects(() => r.d.setPreview(6), /refuses an input with no signal/);
    await r.d.setPreview(4);
    assert.ok(await until(() => r.model.preview === 4));
  } finally { await r.close(); }
});

test('each driver says so when it has reached the other family, and lets the session go', async () => {
  const a = await rig(LiveCoreDriver, 'midra');
  const b = await rig(MidraClassicDriver, 'livecore');
  try {
    assert.ok(await until(() => /this is a Midra/.test(a.error || '')));
    assert.ok(await until(() => /this is a LiveCore/.test(b.error || '')));
    assert.equal(a.status, 'offline');
    await sleep(2500);
    assert.equal(a.status, 'offline', 'and does not come back');
  } finally { await a.close(); await b.close(); }
});
