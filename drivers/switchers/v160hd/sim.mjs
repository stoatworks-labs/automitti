#!/usr/bin/env node
/*
 * A Roland V-160HD's LAN control, answered on this machine:
 *
 *   node drivers/switchers/v160hd/sim.mjs [--port 8023] [--password 0000] [--version 3.50]
 *
 * Built from docs/V160HD.md — the Remote Control Guide plus what the
 * Companion client does — so it agrees with the documents, not necessarily
 * with a unit. Its guesses are marked: ACK as the text `ACK;`, the tally push
 * as one 52-byte frame, and during an AUTO both sources lit PGM until it ends.
 */

import net from 'node:net';
import { fileURLToPath } from 'node:url';

const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');

export async function startV160hdSim(options = {}) {
  const password = options.password ?? '0000';
  const state = {
    pgm: 0, pst: 1, // source codes
    transitioning: false,
    labels: Object.fromEntries(Array.from({ length: 32 }, (_, c) => [c, c === 2 ? 'MITTI' : ''])),
    version: options.version ?? '3.50',
    log: [],
  };
  const clients = new Set();

  const tallyBytes = () => {
    const b = new Array(52).fill(0);
    b[state.pst] |= 2;
    b[state.pgm] |= 1;
    if (state.transitioning) b[state.pst] |= 1;
    return b;
  };
  const pushTally = () => {
    const frame = `DTH:0C0000,${tallyBytes().map(hex).join('')};\n`;
    for (const c of clients) if (c.tally) c.socket.write(frame);
  };

  function take(duration) {
    if (state.transitioning) return;
    if (!duration) {
      [state.pgm, state.pst] = [state.pst, state.pgm];
      pushTally();
      return;
    }
    state.transitioning = true;
    pushTally();
    setTimeout(() => {
      state.transitioning = false;
      [state.pgm, state.pst] = [state.pst, state.pgm];
      pushTally();
    }, duration);
  }

  const server = net.createServer((socket) => {
    const client = { socket, authed: false, tally: false };
    clients.add(client);
    socket.write('Enter password:');
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1').replace(/\x02/g, '');
      if (!client.authed) {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const pw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (pw !== password) { socket.write('\r\nPassword incorrect.\r\n'); socket.end(); return; }
        client.authed = true;
        socket.write('\r\nWelcome to V-160HD.\r\n');
      }
      let i;
      while ((i = buf.indexOf(';')) >= 0) {
        const cmd = buf.slice(0, i).trim();
        buf = buf.slice(i + 1).replace(/^\s+/, '');
        if (cmd) answer(cmd, client);
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  const reply = (client, s) => client.socket.write(`${s};\n`);

  function answer(cmd, client) {
    state.log.push(cmd);
    let m;
    if (cmd === 'VER') return reply(client, `VER:V-160HD,${state.version}`);
    if (cmd === 'ACS') return reply(client, 'ACK');
    if (cmd === 'CUT') { take(0); return reply(client, 'ACK'); }
    if (cmd === 'ATO') { take(options.autoMs ?? 1000); return reply(client, 'ACK'); }
    if ((m = /^DTH:([0-9A-F]{6}),([0-9A-F]+)$/i.exec(cmd))) {
      const [, addr, val] = m;
      const v = parseInt(val, 16);
      switch (addr.toUpperCase()) {
        case '0C0100': client.tally = v === 1; return; // never ACKed, as clients report
        case '002100': state.pgm = v; pushTally(); break;
        case '002101': state.pst = v; pushTally(); break;
        case '0B001E': if (v === 1) take(0); break;
        case '0B001F': if (v === 1) take(options.autoMs ?? 1000); break;
        default: break;
      }
      return reply(client, 'ACK');
    }
    if ((m = /^RQH:([0-9A-F]{6}),([0-9A-F]{6})$/i.exec(cmd))) {
      const addr = m[1].toUpperCase();
      const size = parseInt(m[2], 16);
      if (addr === '002100') return reply(client, `DTH:002100,${[state.pgm, state.pst].slice(0, size).map(hex).join('')}`);
      if (addr === '002101') return reply(client, `DTH:002101,${hex(state.pst)}`);
      if (addr === '0C0000') return reply(client, `DTH:0C0000,${tallyBytes().slice(0, size).map(hex).join('')}`);
      const lm = /^02([0-9A-F]{2})00$/.exec(addr);
      if (lm) {
        const code = parseInt(lm[1], 16) - 0x10;
        const label = (state.labels[code] || '').padEnd(8, '\0').slice(0, 8);
        return reply(client, `DTH:${addr},${[...label].map((ch) => hex(ch.charCodeAt(0))).join('')}`);
      }
      return; // an unknown read gets nothing, as the guide says
    }
    return reply(client, 'ERR:0');
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8023, options.host ?? '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    state,
    take,
    setPreview(code) { state.pst = code; pushTally(); },
    setProgram(code) { state.pgm = code; pushTally(); },
    close: () => new Promise((resolve) => { for (const c of clients) c.socket.destroy(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, f) => (args.includes(n) ? args[args.indexOf(n) + 1] : f);
  const sim = await startV160hdSim({ port: Number(opt('--port', 8023)), password: opt('--password', '0000'), version: opt('--version', '3.50'), host: opt('--host', '127.0.0.1') });
  console.log(`V-160HD sim on :${sim.port} (password ${opt('--password', '0000')})`);
}
