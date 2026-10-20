/*
 * The HyperDeck link against the Mitti sim. The sim's slot behaviour is what
 * a real Mitti 2.8.19 did on 2026-10-20, asked by hand: no reply at all to a
 * bare `slot info`, `202` to `slot info: slot id: 1`. These tests prove the
 * link and the sim agree; the real Mitti run is in docs/MITTI.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { startMittiSim } from '../drivers/players/mitti/sim.mjs';
import { DeckLink } from '../server/lib/hyperdeck/link.js';
import { readTransport, slotQuery } from '../server/lib/hyperdeck/protocol.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(20); }
  return false;
}

test('slot info is asked by number: the transport’s slot, or 1', () => {
  assert.equal(slotQuery(2), 'slot info: slot id: 2');
  assert.equal(readTransport({ 'slot id': 'none' }).slot, null);
  assert.equal(slotQuery(null), 'slot info: slot id: 1', 'a transport that says `slot id: none`');
  assert.equal(slotQuery(undefined), 'slot info: slot id: 1', 'before the transport has answered');
  assert.equal(slotQuery(0), 'slot info: slot id: 1', 'Mitti does not answer slot 0');
});

test('the sim answers a bare `slot info` with nothing, as Mitti 2.8.19 does', async (t) => {
  const sim = await startMittiSim({ oscPort: 0, hyperdeckPort: 0 });
  t.after(() => sim.close());
  const sock = net.connect(sim.hyperdeckPort, '127.0.0.1');
  t.after(() => sock.destroy());
  let got = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => { got += d; });
  await until(() => got.includes('500 connection info'));
  sock.write('slot info\nslot info: slot id: 0\nping\n');
  assert.ok(await until(() => /200 ok/.test(got)), got);
  assert.doesNotMatch(got, /202|1\d\d /, 'no reply to either, not even an error');
  sock.write('slot info: slot id: 1\n');
  assert.ok(await until(() => /202 slot info:\r\nslot id: 1\r\nstatus: mounted/.test(got)), got);
});

test('the link asks for the slot by number, so nothing waits out a reply timeout', async (t) => {
  const sim = await startMittiSim({ oscPort: 0, hyperdeckPort: 0 });
  const link = new DeckLink({ id: 'mitti', name: 'Mitti', host: '127.0.0.1', port: sim.hyperdeckPort, profile: 'mitti' });
  t.after(async () => { link.close(); await sim.close(); });
  link.connect();
  /* Well inside REPLY_TIMEOUT_MS (3 s), which is how long a bare `slot info` held the queue. */
  assert.ok(await until(() => link.transport.status && link.slot.status, 1500), 'transport and slot arrive at once');
  assert.deepEqual(link.slot, { slot: 1, status: 'mounted', volume: 'MITTI_DISK', recordingTime: 0 });
});
