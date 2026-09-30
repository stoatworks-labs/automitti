/*
 * Finding drivers.
 *
 *   <app>/drivers/switchers/<id>/index.js     built in
 *   <app>/drivers/players/<id>/index.js
 *   <data>/drivers/switchers/<id>/index.js    added by the user — same shape
 *   <data>/drivers/players/<id>/index.js
 *
 * A user driver with the same id as a built-in one replaces it, which is how a
 * fix can be tried before it is released. A driver that fails to load or fails
 * the contract is left out and listed in `problems`, never fatal: one broken
 * folder must not stop the app that the show depends on.
 *
 * ⚠️ A driver is code. It runs inside automitti with automitti's access to
 * the network and the disk. Only install drivers you trust.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkDescriptor, describe } from './contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN = path.resolve(here, '..', '..', 'drivers');

export class Registry {
  constructor() {
    this.switchers = new Map();
    this.players = new Map();
    this.sources = new Map(); // "kind:id" → 'built-in' | path
    this.problems = [];
  }

  /** Load every driver under each root, later roots overriding earlier ones. */
  static async load(roots = [BUILTIN], { log = () => {} } = {}) {
    const reg = new Registry();
    for (const root of roots) {
      for (const [folder, kind] of [['switchers', 'switcher'], ['players', 'player']]) {
        const dir = path.join(root, folder);
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
        for (const name of names.sort()) {
          const entry = path.join(dir, name, 'index.js');
          if (!fs.existsSync(entry)) continue;
          const where = root === BUILTIN ? 'built-in' : path.join(dir, name);
          try {
            const mod = await import(pathToFileURL(entry).href);
            const d = mod.default;
            const bad = checkDescriptor(d, kind);
            if (bad.length) {
              reg.problems.push({ path: where, problems: bad });
              log(`driver ${where}: ${bad.join('; ')}`);
              continue;
            }
            const map = kind === 'switcher' ? reg.switchers : reg.players;
            if (map.has(d.id) && where !== 'built-in') log(`driver ${d.kind} "${d.id}" from ${where} replaces the built-in one`);
            map.set(d.id, d);
            reg.sources.set(`${kind}:${d.id}`, where);
          } catch (err) {
            reg.problems.push({ path: where, problems: [err.message] });
            log(`driver ${where} would not load: ${err.message}`);
          }
        }
      }
    }
    return reg;
  }

  switcher(id) { return this.switchers.get(id) || null; }
  player(id) { return this.players.get(id) || null; }

  /** Everything the settings page shows. */
  list() {
    return {
      switchers: [...this.switchers.values()].map((d) => describe(d, this.sources.get(`switcher:${d.id}`))),
      players: [...this.players.values()].map((d) => describe(d, this.sources.get(`player:${d.id}`))),
      problems: this.problems,
    };
  }
}
