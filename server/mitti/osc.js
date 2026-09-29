/*
 * OSC 1.0 over UDP, the subset Mitti and Companion use: messages and bundles,
 * argument types i f s b T F N. No dependency — the wire format is small and a
 * library would still need wrapping to keep the raw packet for the relay.
 */

const pad4 = (n) => (n + 3) & ~3;

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end += 1;
  if (end >= buf.length) throw new Error('unterminated OSC string');
  return { value: buf.toString('utf8', off, end), next: pad4(end + 1) };
}

function writeString(s) {
  const raw = Buffer.from(String(s), 'utf8');
  const out = Buffer.alloc(pad4(raw.length + 1));
  raw.copy(out);
  return out;
}

/**
 * One packet into a flat list of messages; a bundle's timetag is ignored
 * (Mitti never schedules). Throws on a malformed packet.
 */
export function decode(buf) {
  const out = [];
  decodeInto(buf, out);
  return out;
}

function decodeInto(buf, out) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 8) === '#bundle\0') {
    let off = 16;
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      if (size < 0 || off + size > buf.length) throw new Error('bad OSC bundle element');
      decodeInto(buf.subarray(off, off + size), out);
      off += size;
    }
    return;
  }
  const addr = readString(buf, 0);
  if (!addr.value.startsWith('/')) throw new Error('not an OSC address');
  let off = addr.next;
  let tags = ',';
  if (off < buf.length) {
    const t = readString(buf, off);
    tags = t.value;
    off = t.next;
  }
  const args = [];
  for (const tag of tags.slice(1)) {
    switch (tag) {
      case 'i': args.push(buf.readInt32BE(off)); off += 4; break;
      case 'f': args.push(buf.readFloatBE(off)); off += 4; break;
      case 'd': args.push(buf.readDoubleBE(off)); off += 8; break;
      case 'h': args.push(Number(buf.readBigInt64BE(off))); off += 8; break;
      case 's': case 'S': { const s = readString(buf, off); args.push(s.value); off = s.next; break; }
      case 'b': {
        const n = buf.readInt32BE(off);
        args.push(Buffer.from(buf.subarray(off + 4, off + 4 + n)));
        off = pad4(off + 4 + n);
        break;
      }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      case 'I': args.push(Infinity); break;
      default: throw new Error(`unsupported OSC type tag '${tag}'`);
    }
  }
  out.push({ address: addr.value, args });
}

/**
 * Encode one message. Args may be plain JS values (integer → i, other number
 * → f, string → s, boolean → T/F, Buffer → b) or `{type, value}` to force one.
 */
export function encode(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    const { type, value } = a && typeof a === 'object' && !Buffer.isBuffer(a) && 'type' in a
      ? a
      : { type: inferType(a), value: a };
    tags += type;
    switch (type) {
      case 'i': { const b = Buffer.alloc(4); b.writeInt32BE(value | 0); parts.push(b); break; }
      case 'f': { const b = Buffer.alloc(4); b.writeFloatBE(Number(value)); parts.push(b); break; }
      case 's': parts.push(writeString(value)); break;
      case 'b': {
        const len = Buffer.alloc(4);
        len.writeInt32BE(value.length);
        parts.push(len, value, Buffer.alloc(pad4(value.length) - value.length));
        break;
      }
      case 'T': case 'F': case 'N': break;
      default: throw new Error(`cannot encode OSC type '${type}'`);
    }
  }
  return Buffer.concat([writeString(address), writeString(tags), ...parts]);
}

function inferType(v) {
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'number') return Number.isInteger(v) ? 'i' : 'f';
  if (Buffer.isBuffer(v)) return 'b';
  if (v === null) return 'N';
  return 's';
}
