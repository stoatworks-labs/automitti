import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { V160hdDriver } from '../drivers/switchers/v160hd/driver.js';
import { Switcher } from '../server/core/switcher.js';
import { Player } from '../server/core/player.js';
import { Registry } from '../server/core/registry.js';
import { Rules } from '../server/rules.js';
import { normalise } from '../server/config.js';
import { startV160hdSim } from '../drivers/switchers/v160hd/sim.mjs';
import { startMittiSim } from '../drivers/players/mitti/sim.mjs';

const registry = await Registry.load();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

test('V-160HD: logs in, reads labels and buses, follows pushed tally, cuts', async () => {
  const sim = await startV160hdSim({ port: 0, password: '4321', autoMs: 300 });
  const d = new V160hdDriver({ host: '127.0.0.1', port: sim.port, password: '4321' });
  const model = {};
  let status = null;
  d.on('status', (s) => { status = s; });
  d.on('state', (p) => Object.assign(model, p));
  d.connect();
  assert.ok(await until(() => status === 'online'));
  assert.ok(await until(() => model.program === 1 && model.preview === 2));
  assert.ok(await until(() => model.inputs?.[2]?.name === 'MITTI'), 'label read');
  assert.equal(model.device.version, '3.50');

  await d.setPreview(3);
  assert.ok(await until(() => model.preview === 3 && model.tally[3]?.preview));
  await d.auto();
  /* Mid-AUTO both sources are lit PGM (the sim's documented guess). */
  assert.ok(await until(() => model.tally[3]?.program && model.tally[1]?.program, 250));
  assert.ok(await until(() => model.program === 3 && !model.tally[1]?.program));
  await d.cut();
  assert.ok(await until(() => model.program === 1));
  assert.ok(sim.state.log.includes('ATO') && sim.state.log.includes('CUT'), 'plain-text commands on 3.5');
  d.close();
  await sim.close();
});

test('V-160HD: a wrong password is reported, not retried silently', async () => {
  const sim = await startV160hdSim({ port: 0, password: '1111' });
  const d = new V160hdDriver({ host: '127.0.0.1', port: sim.port, password: '0000' });
  const seen = [];
  d.on('status', (s, e) => seen.push([s, e]));
  d.connect();
  assert.ok(await until(() => seen.some(([s, e]) => s === 'offline' && /password/.test(e || ''))));
  d.close();
  await sim.close();
});

test('V-160HD firmware before 3.3 presses the panel buttons', async () => {
  const sim = await startV160hdSim({ port: 0, password: '0000', version: '3.02' });
  const d = new V160hdDriver({ host: '127.0.0.1', port: sim.port, password: '0000' });
  let online = false;
  d.on('status', (s) => { online = s === 'online'; });
  d.connect();
  await until(() => online);
  await until(() => d.version === '3.02');
  await d.cut();
  assert.ok(sim.state.log.includes('DTH:0B001E,01') && sim.state.log.includes('DTH:0B001E,00'));
  d.close();
  await sim.close();
});

test('rules: play on program, pause off air, AUTO at the cue end — through the hosts, sims end to end', async () => {
  const mittiSim = await startMittiSim({ oscPort: 0, hyperdeckPort: 0, cues: [
    { name: 'A', seconds: 30, id: 'A' }, { name: 'Short', seconds: 1.2, id: 'S' }, { name: 'C', seconds: 30, id: 'C' },
  ] });
  const swSim = await startV160hdSim({ port: 0, password: '0000', autoMs: 100 });
  const cfg = normalise({
    player: { type: 'mitti', settings: { mitti: { host: '127.0.0.1', oscPort: mittiSim.oscPort, feedbackPort: 0, advertise: false, hyperdeckPort: mittiSim.hyperdeckPort } } },
    switcher: { type: 'v160hd', input: 'MITTI', settings: { v160hd: { host: '127.0.0.1', port: swSim.port, password: '0000' } } },
    rules: { enabled: true, onProgram: 'play', onLeave: 'pause', onEnd: 'auto' },
  });
  const config = () => cfg;
  const player = new Player({ config, registry });
  await player.start();
  mittiSim.setFeedback({ host: '127.0.0.1', port: player.driver.osc.listenPort });
  const switcher = new Switcher({ config, registry });
  await switcher.start();
  const rules = new Rules({ config, switcher, player });
  const did = [];
  rules.on('change', () => { const w = rules.snapshot().last?.what; if (w && did.at(-1) !== w) did.push(w); });
  rules.start();

  try {
    assert.ok(await until(() => switcher.status === 'online' && switcher.playerInput() === 3));
    assert.equal(switcher.inputCount(), 52);
    player.command('/mitti/2/jump');
    assert.ok(await until(() => player.snapshot().current.name === 'Short'));
    assert.equal(player.snapshot().playing, false);

    await switcher.command('preview', 3);
    await until(() => switcher.model.preview === 3);
    await switcher.command('auto');
    assert.ok(await until(() => switcher.model.program === 3), 'player taken to program');
    assert.ok(await until(() => mittiSim.state.playing), 'rolled on program');
    /* The cue ends by itself → the rule AUTOs away → the player is off air → paused. */
    assert.ok(await until(() => switcher.model.program === 1, 4000), 'took away at the end');
    assert.ok(await until(() => did.includes('taken off → pause')));
    assert.deepEqual(did, ['on program → play', 'cue ended → auto', 'taken off → pause']);
    assert.equal(mittiSim.state.playing, false);
  } finally {
    switcher.stop();
    await player.stop();
    await mittiSim.close();
    await swSim.close();
  }
});

test('an unknown driver is reported, not fatal', async () => {
  const cfg = normalise({ switcher: { type: 'no-such-switcher' }, player: { type: 'no-such-player' } });
  const s = new Switcher({ config: () => cfg, registry });
  await s.start();
  assert.match(s.snapshot().error, /no switcher driver called "no-such-switcher"/);
  const p = new Player({ config: () => cfg, registry });
  await p.start();
  assert.match(p.snapshot().error, /no player driver called "no-such-player"/);
  await assert.rejects(() => p.act('play'), /no player/);
});

test('a switcher missing a required setting says which', async () => {
  const cfg = normalise({ switcher: { type: 'v160hd', settings: { v160hd: { password: '0000' } } } });
  const s = new Switcher({ config: () => cfg, registry });
  await s.start();
  assert.match(s.snapshot().error, /needs address/);
});

test('manual switcher derives tally from program/preview', async () => {
  const cfg = normalise({ switcher: { type: 'manual', input: '4' } });
  const s = new Switcher({ config: () => cfg, registry });
  await s.start();
  await s.command('program', 4);
  assert.deepEqual(s.tallyOf(4), { program: true, preview: false });
  await s.command('preview', 2);
  await s.command('cut');
  assert.deepEqual(s.tallyOf(4), { program: false, preview: true });
  assert.equal(s.playerInput(), 4);
  assert.equal(s.inputCount(), 20);
});
