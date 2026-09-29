import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { decode, encode } from '../server/mitti/osc.js';
import { applyFeedback, emptyPlayback, tcToSeconds, cueList } from '../server/mitti/feedback.js';
import { MittiOscLink } from '../server/mitti/oscLink.js';
import { normalise } from '../server/config.js';
import { startMittiSim } from '../tools/mitti-sim.mjs';

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
  const c = normalise({ switcher: { type: 'bogus', port: 'x' }, rules: { onEnd: 'explode', lead: 999 }, destinations: [null, { host: 'h', port: 70000 }] });
  assert.equal(c.switcher.type, 'none');
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
