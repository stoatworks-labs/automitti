/*
 * The Bonjour services automitti publishes, so Mitti's own pickers list it:
 *
 *   _osc._udp            Mitti's "Feedback To" dropdown
 *   _switcher_ctrl._udp  Mitti's ATEM device list (what real ATEMs announce)
 *
 * `set()` takes the whole wanted list and republishes only what changed.
 */

import { Bonjour } from 'bonjour-service';

export class Advertiser {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.bonjour = null;
    this.live = new Map(); // key → { spec, service }
  }

  set(specs) {
    const wanted = new Map(specs.map((s) => [s.key, s]));
    for (const [key, entry] of this.live) {
      const next = wanted.get(key);
      if (!next || JSON.stringify(next) !== JSON.stringify(entry.spec)) {
        entry.service.stop?.();
        this.live.delete(key);
      }
    }
    for (const [key, spec] of wanted) {
      if (this.live.has(key)) continue;
      this.bonjour ??= new Bonjour();
      try {
        const service = this.bonjour.publish({
          name: spec.name,
          type: spec.type,
          protocol: spec.protocol || 'udp',
          port: spec.port,
          txt: spec.txt,
          disableIPv6: true,
          /* Pinned to one address: a host name of our own that resolves only
             to it. Mitti connects to the FIRST IPv4 a service resolves to, and
             on a machine with a VPN (ZeroTier, Tailscale) that is often not
             the show network. */
          ...(spec.address ? { host: `automitti-${spec.address.replace(/\./g, '-')}.local` } : {}),
        });
        if (spec.address) {
          const all = service.records.bind(service);
          service.records = () => all().filter((r) => r.type !== 'A' || r.data === spec.address)
            .concat(all().some((r) => r.type === 'A' && r.data === spec.address) ? [] : [{ name: service.host, type: 'A', ttl: 120, data: spec.address }]);
        }
        service.on?.('error', (err) => this.log(`Bonjour ${spec.type}: ${err.message}`));
        this.live.set(key, { spec, service });
        this.log(`Bonjour: announcing ${spec.name} as _${spec.type}._${spec.protocol || 'udp'} on ${spec.port}`);
      } catch (err) {
        this.log(`Bonjour ${spec.type}: ${err.message}`);
      }
    }
  }

  stop() {
    for (const { service } of this.live.values()) service.stop?.();
    this.live.clear();
    this.bonjour?.destroy();
    this.bonjour = null;
  }
}
