/*
 * SLIP framing (RFC 1055), double-ended — an END byte before and after every
 * packet — which is what OSC 1.1 asks for on a stream and what QLab speaks on
 * TCP 53000. Shared by the driver and the simulator.
 */

const END = 0xc0;
const ESC = 0xdb;
const ESC_END = 0xdc;
const ESC_ESC = 0xdd;

/* A reply bigger than this is not something QLab sends; drop it rather than grow without bound. */
const MAX_FRAME = 16 * 1024 * 1024;

/** One packet, framed. */
export function slipEncode(packet) {
  const out = [END];
  for (const b of packet) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return Buffer.from(out);
}

/** Feed it the stream as it arrives; it calls `onFrame(packet)` once per whole packet. */
export class SlipDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.parts = [];
    this.size = 0;
    this.esc = false;
  }

  push(chunk) {
    let start = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (this.esc) {
        this.esc = false;
        this.#add(Buffer.from([b === ESC_END ? END : b === ESC_ESC ? ESC : b]));
        start = i + 1;
      } else if (b === ESC) {
        this.#add(chunk.subarray(start, i));
        this.esc = true;
        start = i + 1;
      } else if (b === END) {
        this.#add(chunk.subarray(start, i));
        start = i + 1;
        this.#flush();
      }
    }
    this.#add(chunk.subarray(start));
  }

  #add(buf) {
    if (!buf.length || this.overflow) return;
    this.size += buf.length;
    if (this.size > MAX_FRAME) { this.overflow = true; this.parts = []; return; }
    /* Copied: the chunk it came from is reused by the socket. */
    this.parts.push(Buffer.from(buf));
  }

  #flush() {
    const { size, parts, overflow } = this;
    this.parts = [];
    this.size = 0;
    this.overflow = false;
    if (size && !overflow) this.onFrame(Buffer.concat(parts, size));
  }
}
