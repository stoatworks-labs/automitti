/*
 * The emulated ATEM against a second, independent client implementation
 * (atem-connection, the one Companion uses). The Blackmagic SDK itself —
 * which is what Mitti runs — is checked by `tools/sdk-check.sh <addr> --takes`, since it
 * needs the ATEM software installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Atem } from 'atem-connection';
import { AtemServer } from '../server/atem/server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

test('atem-connection connects, reads inputs and tally, and its commands arrive', async () => {
  const server = new AtemServer({ port: 0, bind: '127.0.0.1', name: 'test rig', inputCount: 6 });
  await server.start();
  server.setState({ inputs: [{ id: 3, name: 'Mitti', short: 'MIT' }], program: 1, preview: 3, tally: {} });
  const commands = [];
  server.on('command', (c) => {
    commands.push(c);
    /* Behave like the bridge: the "real switcher" does it and reports back. */
    if (c.action === 'preview') server.setState({ preview: c.input, tally: {} });
    if (c.action === 'cut') server.setState({ program: server.state.preview, preview: server.state.program, tally: {} });
  });

  const atem = new Atem({ disableMultithreaded: true });
  const connected = new Promise((r) => atem.once('connected', r));
  atem.connect('127.0.0.1', server.port);
  await Promise.race([connected, sleep(5000).then(() => { throw new Error('no connect'); })]);

  assert.equal(atem.state.info.productIdentifier, 'test rig');
  assert.equal(atem.state.inputs[3].longName, 'Mitti');
  assert.equal(atem.state.video.mixEffects[0].programInput, 1);
  assert.equal(atem.state.video.mixEffects[0].previewInput, 3);

  await atem.changePreviewInput(2);
  await atem.cut();
  assert.ok(await until(() => commands.some((c) => c.action === 'cut')));
  assert.deepEqual(commands.map((c) => c.action), ['preview', 'cut']);
  assert.equal(commands[0].input, 2);
  assert.ok(await until(() => atem.state.video.mixEffects[0].programInput === 2));

  /* Layer-switcher tally: two inputs on air at once reach the client. */
  server.setState({ tally: { 2: { program: true, preview: false }, 5: { program: true, preview: false } } });
  assert.ok(await until(() => atem.state.info && server.list().length === 1));

  await atem.disconnect();
  await atem.destroy();
  /* atem-connection just goes quiet (the SDK sends a close); silence drops it after 5 s. */
  assert.ok(await until(() => server.list().length === 0, 7000));
  server.stop();
});

test('a change of input count drops clients so they resync', async () => {
  const server = new AtemServer({ port: 0, bind: '127.0.0.1', inputCount: 4 });
  await server.start();
  const atem = new Atem({ disableMultithreaded: true });
  const connected = new Promise((r) => atem.once('connected', r));
  atem.connect('127.0.0.1', server.port);
  await connected;
  assert.equal(server.list().length, 1);
  server.setInputCount(8);
  assert.equal(server.list().length, 0);
  await atem.destroy();
  server.stop();
});
