/*
 * Several devices — several Mittis — on one switcher: each follows its own
 * input, they come and go with the settings, and they never share a port.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { Registry } from '../server/core/registry.js';
import { Switcher } from '../server/core/switcher.js';
import { Devices } from '../server/devices.js';
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

/* UDP ports nothing holds right now. */
async function freePorts(n) {
  const socks = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '0.0.0.0', () => resolve(s));
  })));
  const ports = socks.map((s) => s.address().port);
  await Promise.all(socks.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

const canBind = (port) => new Promise((resolve) => {
  const s = dgram.createSocket('udp4');
  s.once('error', () => resolve(false));
  s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
});

/* A Mitti that needs nothing on the other end: no HyperDeck, no Bonjour. */
const mitti = ({ oscPort = 9, feedbackPort = 0 } = {}) => ({
  type: 'mitti',
  settings: { mitti: { host: '127.0.0.1', oscPort, feedbackPort, hyperdeck: false, advertise: false } },
});

test('two Mittis on one switcher: each rolls on its own input, and only its own', async () => {
  const simA = await startMittiSim({ oscPort: 0, hyperdeckPort: false });
  const simB = await startMittiSim({ oscPort: 0, hyperdeckPort: false });
  const swSim = await startV160hdSim({ port: 0, password: '0000' });
  const rules = { enabled: true, onProgram: 'play', onLeave: 'pause' };
  const cfg = normalise({
    switcher: { type: 'v160hd', settings: { v160hd: { host: '127.0.0.1', port: swSim.port, password: '0000' } } },
    devices: [
      { id: 'main', name: 'Main', player: mitti({ oscPort: simA.oscPort }), input: 'MITTI', rules },
      { id: 'backup', name: 'Backup', player: mitti({ oscPort: simB.oscPort }), input: '4', rules },
    ],
  });
  const switcher = new Switcher({ config: () => cfg, registry });
  const devices = new Devices({ config: () => cfg, switcher, registry });
  await devices.start();
  await switcher.start();
  const main = devices.get('main');
  const backup = devices.get('BACKUP');
  simA.setFeedback({ host: '127.0.0.1', port: main.player.driver.osc.listenPort });
  simB.setFeedback({ host: '127.0.0.1', port: backup.player.driver.osc.listenPort });
  const tally = (id) => devices.snapshot().find((d) => d.id === id).tally;

  try {
    assert.ok(await until(() => devices.snapshot().every((d) => d.player.online)), 'both online');
    assert.ok(await until(() => main.input() === 3 && backup.input() === 4), 'inputs by name and by number');
    assert.equal(devices.get(), main, 'no device named is the first');

    await switcher.command('preview', 3);
    assert.ok(await until(() => tally('main').preview));
    await switcher.command('cut');
    assert.ok(await until(() => simA.state.playing), 'Main rolled on its input');
    assert.deepEqual(tally('main'), { program: true, preview: false });
    assert.equal(simB.state.playing, false, 'Backup did not');

    await switcher.command('preview', 4);
    await until(() => tally('backup').preview);
    await switcher.command('cut');
    assert.ok(await until(() => simB.state.playing), 'Backup rolled on its input');
    assert.ok(await until(() => !simA.state.playing), 'Main paused once taken off');
    assert.equal(devices.snapshot()[0].rules.last.what, 'taken off → pause');
  } finally {
    await devices.stop();
    switcher.stop();
    await simA.close();
    await simB.close();
    await swSim.close();
  }
});

test('devices come and go with the settings, and can trade ports in one save', async () => {
  const [p1, p2] = await freePorts(2);
  const dev = (id, port) => ({ id, player: mitti({ feedbackPort: port }) });
  let cfg = normalise({ devices: [dev('a', p1)] });
  const config = () => cfg;
  const switcher = new Switcher({ config, registry });
  const devices = new Devices({ config, switcher, registry });
  const port = (id) => devices.get(id)?.player.driver?.osc.listenPort;
  await devices.start();
  try {
    cfg = normalise({ devices: [dev('a', p1), dev('b', p2)] });
    await devices.reconfigure();
    assert.deepEqual(devices.list().map((d) => d.id), ['a', 'b'], 'added');
    assert.deepEqual([port('a'), port('b')], [p1, p2]);

    cfg = normalise({ devices: [dev('a', p2), dev('b', p1)] });
    await devices.reconfigure();
    assert.deepEqual([port('a'), port('b')], [p2, p1], 'swapped');
    assert.deepEqual(devices.snapshot().map((d) => d.player.error), [null, null], 'neither found its port taken');

    cfg = normalise({ devices: [dev('b', p1)] });
    await devices.reconfigure();
    assert.deepEqual(devices.list().map((d) => d.id), ['b'], 'removed');
    assert.ok(await canBind(p2), 'the removed device let its port go');
    assert.equal(switcher.listenerCount('tally'), 2, 'and let go of the switcher: one NDI tally and one rule set left');
  } finally {
    await devices.stop();
  }
});

test('a new device gets its own feedback port, and two that share one are flagged', async () => {
  let cfg = normalise({ devices: [{ player: mitti({ feedbackPort: 51010 }) }, { player: mitti({ feedbackPort: 51011 }) }] });
  const config = () => cfg;
  const devices = new Devices({ config, switcher: new Switcher({ config, registry }), registry });
  assert.deepEqual(devices.draft(), { id: 'mitti-3', name: 'Mitti 3', player: { type: 'mitti', settings: { mitti: { feedbackPort: 51012 } } } });

  const [p] = await freePorts(1);
  cfg = normalise({ devices: [{ name: 'Main', player: mitti({ feedbackPort: p }) }, { name: 'Backup', player: mitti({ feedbackPort: p }) }] });
  await devices.start();
  try {
    const [main, backup] = devices.snapshot();
    assert.deepEqual(main.warnings, [`Feedback listen port ${p} is also Backup's`]);
    assert.deepEqual(backup.warnings, [`Feedback listen port ${p} is also Main's`]);
    assert.match(backup.player.error, /already in use/);
  } finally {
    await devices.stop();
  }
});
