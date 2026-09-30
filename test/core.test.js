import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { decode, encode } from '../server/lib/osc.js';
import { applyFeedback, emptyPlayback, tcToSeconds, cueList } from '../drivers/players/mitti/feedback.js';
import { MittiOscLink } from '../drivers/players/mitti/osc-link.js';
import { normalise } from '../server/config.js';
import { startMittiSim } from '../drivers/players/mitti/sim.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('OSC round-trips every type Mitti and Companion use', () => {
  const buf = encode('/mitti/x', [1, 0.5, 'hé', true, false, Buffer.from([1, 2, 3]), { type: 'f', value: 2 }]);
  const [m] = decode(buf);
  assert.equal(m.address, '/mitti/x');
  assert.equal(m.args[0], 1);
  assert.equal(m.args[1], 0.5);
  assert.equal(m.args[2], 'hé');
  assert.equal(m.args[3], true);
  assert.equal(m.args[4], false);
  assert.deepEqual([...m.args[5]], [1, 2, 3]);
  assert.equal(m.args[6], 2);
});

test('OSC bundles are flattened', () => {
  const a = encode('/a', [1]);
  const b = encode('/b', ['x']);
  const head = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8)]);
  const size = (x) => { const s = Buffer.alloc(4); s.writeInt32BE(x.length); return s; };
  const msgs = decode(Buffer.concat([head, size(a), a, size(b), b]));
  assert.deepEqual(msgs.map((m) => m.address), ['/a', '/b']);
});

test('feedback folds into playback state', () => {
  const s = emptyPlayback();
  applyFeedback(s, { address: '/mitti/togglePlay', args: [1] });
  applyFeedback(s, { address: '/mitti/currentCueName', args: ['Opener'] });
  applyFeedback(s, { address: '/mitti/cueTimeLeft', args: ['00:00:10:24'] });
  applyFeedback(s, { address: '/mitti/2/cueName', args: ['B'] });
  applyFeedback(s, { address: '/mitti/1/cueName', args: ['A'] });
  assert.equal(s.playing, true);
  assert.equal(s.current.name, 'Opener');
  assert.equal(s.fps, 25);
  assert.deepEqual(cueList(s).map((c) => c.name), ['A', 'B']);
  applyFeedback(s, { address: '/mitti/2/deleted', args: [1] });
  assert.deepEqual(cueList(s).map((c) => c.name), ['A']);
  assert.equal(tcToSeconds('00:01:02:12', 25), 62.48);
  assert.equal(tcToSeconds('-00:00:01:00', 25), -1);
  assert.equal(tcToSeconds('nonsense'), null);
});

test('config normalises junk into defaults', () => {
  const c = normalise({ switcher: { type: 'Not An Id!', settings: { v160hd: 'x', midra: { host: 'h' } } }, rules: { onEnd: 'explode', lead: 999 }, destinations: [null, { host: 'h', port: 70000 }] });
  assert.equal(c.switcher.type, 'none');
  assert.deepEqual(c.switcher.settings, { midra: { host: 'h' } });
  assert.equal(c.player.type, 'mitti');
  assert.equal(c.rules.onEnd, 'none');
  assert.equal(c.rules.lead, 60);
  assert.equal(c.destinations.length, 1);
  assert.equal(c.destinations[0].port, 51001);
  assert.equal(c.atem.enabled, false);
});

test('the OSC link relays feedback byte for byte and tracks liveness', async () => {
  const sink = dgram.createSocket('udp4');
  await new Promise((r) => sink.bind(0, '127.0.0.1', r));
  const got = [];
  sink.on('message', (b) => got.push(b));

  const sim = await startMittiSim({ oscPort: 0, hyperdeckPort: false });
  const link = new MittiOscLink({
    target: () => ({ host: '127.0.0.1', port: sim.oscPort }),
    listenPort: 0,
    destinations: () => [{ host: '127.0.0.1', port: sink.address().port, enabled: true }, { host: '127.0.0.1', port: 9, enabled: false }],
  });
  const seen = [];
  link.on('message', (m) => seen.push(m.address));
  await link.start();
  sim.setFeedback({ host: '127.0.0.1', port: link.listenPort });
  link.send('/mitti/resendOSCFeedback');
  link.send('/mitti/ping');
  await sleep(300);
  assert.ok(link.online, 'pong seen');
  assert.ok(seen.includes('/mitti/1/cueName'));
  assert.ok(seen.includes('/mitti/currentCueName'));
  assert.equal(got.length, link.stats.received, 'every packet relayed');
  assert.deepEqual(decode(got[0])[0].address.startsWith('/mitti/'), true);

  /* A stranger on the feedback port is not Mitti and is not relayed. */
  const before = got.length;
  const stranger = dgram.createSocket('udp4');
  stranger.send(encode('/mitti/currentCueName', ['spoof']), link.listenPort, '127.0.0.2');
  await sleep(100);
  stranger.close();
  assert.equal(got.length, before);

  link.stop();
  sink.close();
  await sim.close();
});

test('a v0.1.0 settings file carries across to per-driver settings', () => {
  const c = normalise({
    mitti: { host: '10.0.0.9', oscPort: 51000, feedbackPort: 51010, hyperdeck: true },
    switcher: { type: 'v160hd', host: '10.0.0.2', port: 8023, password: '1234', mittiInput: 'MITTI', screens: [], layer: 1 },
    rules: { enabled: true, via: 'hyperdeck' },
  });
  assert.equal(c.player.type, 'mitti');
  assert.equal(c.player.settings.mitti.host, '10.0.0.9');
  assert.equal(c.switcher.type, 'v160hd');
  assert.equal(c.switcher.input, 'MITTI');
  assert.equal(c.switcher.settings.v160hd.password, '1234');
  assert.equal(c.rules.via, 'hyperdeck');
  assert.equal('mitti' in c, false);
  /* Normalising the result again changes nothing. */
  assert.deepEqual(normalise(c), c);
});

test('the emulated ATEM id is created once and kept, whatever the host is called', async () => {
  const { ConfigStore, legacyAtemId } = await import('../server/config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automitti-cfg-'));
  try {
    /* A v0.1.0 file has no id: it gets the one v0.1.0 announced here, so Mitti's pairing survives. */
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ atem: { enabled: true, name: 'automitti' } }));
    const a = new ConfigStore(dir);
    assert.equal(a.get().atem.uniqueId, legacyAtemId('automitti'));
    assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).atem.uniqueId, /^[0-9a-f]{32}$/, 'written to disk at once');
    /* Stored, so a later rename of the machine changes nothing. */
    const kept = a.get().atem.uniqueId;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...a.get(), atem: { ...a.get().atem, uniqueId: 'ab'.repeat(16) } }));
    assert.equal(new ConfigStore(dir).get().atem.uniqueId, 'ab'.repeat(16));
    /* A save that leaves the id out does not reset it. */
    const b = new ConfigStore(dir);
    const next = structuredClone(b.get()); delete next.atem.uniqueId;
    assert.equal(b.set(next).atem.uniqueId, 'ab'.repeat(16));
    assert.notEqual(kept, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('feedback from this machine by its LAN address counts as Mitti on 127.0.0.1', async () => {
  const osMod = await import('node:os');
  const lan = Object.values(osMod.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!lan) return; // no LAN interface on this runner
  const link = new MittiOscLink({ target: () => ({ host: '127.0.0.1', port: 9 }), listenPort: 0, destinations: () => [] });
  const seen = [];
  link.on('message', (m) => seen.push(m.address));
  await link.start();
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, lan, r));
  sock.send(encode('/mitti/currentCueName', ['From the LAN address']), link.listenPort, lan);
  await sleep(150);
  sock.close();
  link.stop();
  assert.deepEqual(seen, ['/mitti/currentCueName']);
});
