/*
 * NDI tally for Mitti's NDI trigger.
 *
 * With "NDI" chosen as its integration, Mitti plays when a receiver of its NDI
 * output reports that output as on program (IMTNDIKit reads
 * NDIlib_send_get_tally). automitti becomes that receiver: it connects to
 * Mitti's NDI source with METADATA-ONLY bandwidth — no video crosses the
 * network — and sets the tally from the real switcher: on program while
 * Mitti's switcher input is on air, on preview while it is in preview.
 *
 * NDI is loaded at runtime from the NDI runtime or SDK already on the machine
 * (NDI Tools installs it); nothing of NDI's is shipped in this app. With no
 * runtime found, this part stays off and says why.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = () => {
  const env = process.env.NDI_RUNTIME_DIR_V6 || process.env.NDI_RUNTIME_DIR_V5;
  if (process.platform === 'darwin') {
    return [
      env && path.join(env, 'libndi.dylib'),
      '/usr/local/lib/libndi.dylib',
      '/Library/NDI SDK for Apple/lib/macOS/libndi.dylib',
      '/Applications/NDI Video Monitor.app/Contents/Frameworks/libndi_advanced.dylib',
    ];
  }
  if (process.platform === 'win32') {
    return [env && path.join(env, 'Processing.NDI.Lib.x64.dll')];
  }
  return [env && path.join(env, 'libndi.so.6'), '/usr/lib/libndi.so.6', '/usr/local/lib/libndi.so.6', 'libndi.so.6', 'libndi.so.5'];
};

const METADATA_ONLY = -10;
const COLOR_FASTEST = 100;
const FRAME_METADATA = 3;

let lib = null;
let loadError = null;

async function loadNdi(explicit) {
  if (lib) return lib;
  let koffi;
  try {
    koffi = (await import('koffi')).default;
  } catch (err) {
    loadError = `the FFI module is missing (${err.message})`;
    return null;
  }
  const paths = [explicit, ...CANDIDATES()].filter(Boolean);
  const file = paths.find((p) => !path.isAbsolute(p) || fs.existsSync(p));
  if (!file) {
    loadError = 'no NDI runtime found — install NDI Tools, or set the library path';
    return null;
  }
  try {
    const so = koffi.load(file);
    const source = koffi.struct('NDIlib_source_t', { p_ndi_name: 'const char *', p_url_address: 'const char *' });
    const findCreate = koffi.struct('NDIlib_find_create_t', { show_local_sources: 'bool', p_groups: 'const char *', p_extra_ips: 'const char *' });
    const recvCreate = koffi.struct('NDIlib_recv_create_v3_t', {
      source_to_connect_to: source, color_format: 'int', bandwidth: 'int', allow_video_fields: 'bool', p_ndi_recv_name: 'const char *',
    });
    const tally = koffi.struct('NDIlib_tally_t', { on_program: 'bool', on_preview: 'bool' });
    const meta = koffi.struct('NDIlib_metadata_frame_t', { length: 'int', timecode: 'int64', p_data: 'void *' });
    lib = {
      koffi,
      file,
      source,
      meta,
      initialize: so.func('bool NDIlib_initialize()'),
      version: so.func('const char *NDIlib_version()'),
      findCreate: so.func('void *NDIlib_find_create_v2(const NDIlib_find_create_t *p)'),
      findSources: so.func('const NDIlib_source_t *NDIlib_find_get_current_sources(void *inst, _Out_ uint32_t *count)'),
      findDestroy: so.func('void NDIlib_find_destroy(void *inst)'),
      recvCreate: so.func('void *NDIlib_recv_create_v3(const NDIlib_recv_create_v3_t *p)'),
      recvDestroy: so.func('void NDIlib_recv_destroy(void *inst)'),
      setTally: so.func('bool NDIlib_recv_set_tally(void *inst, const NDIlib_tally_t *t)'),
      connections: so.func('int NDIlib_recv_get_no_connections(void *inst)'),
      capture: so.func('int NDIlib_recv_capture_v2(void *inst, void *v, void *a, _Out_ NDIlib_metadata_frame_t *m, uint32_t timeout)'),
      freeMeta: so.func('void NDIlib_recv_free_metadata(void *inst, const NDIlib_metadata_frame_t *m)'),
      tallyType: tally,
      findCreateType: findCreate,
      recvCreateType: recvCreate,
    };
    if (!lib.initialize()) {
      loadError = 'NDI would not initialise on this CPU';
      lib = null;
      return null;
    }
    loadError = null;
    return lib;
  } catch (err) {
    loadError = `could not load ${file}: ${err.message}`;
    lib = null;
    return null;
  }
}

export class NdiTally extends EventEmitter {
  constructor({ config, switcher, log = () => {} }) {
    super();
    this.config = config;
    this.switcher = switcher;
    this.log = log;
    this.finder = null;
    this.recv = null;
    this.connectedTo = null;
    this.connections = 0;
    this.sent = { program: false, preview: false };
    this.timer = null;
    this.error = null;
    this.onTally = () => this.#push();
  }

  async start() {
    this.switcher.on('tally', this.onTally);
    this.switcher.on('change', this.onTally);
    await this.#open();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.#dropReceiver();
    if (this.finder && lib) lib.findDestroy(this.finder);
    this.finder = null;
  }

  async reconfigure(prev) {
    const a = prev.ndi; const b = this.config().ndi;
    if (a.enabled !== b.enabled || a.source !== b.source || a.library !== b.library) {
      this.stop();
      await this.#open();
    }
    this.#push();
  }

  async #open() {
    const c = this.config().ndi;
    this.error = null;
    if (!c.enabled) { this.emit('change'); return; }
    const ndi = await loadNdi(c.library);
    if (!ndi) {
      this.error = loadError;
      this.log(`NDI: ${this.error}`);
      this.emit('change');
      return;
    }
    this.#ensureFinder();
    this.timer = setInterval(() => this.#tick(), 250);
    this.#tick();
  }

  #ensureFinder() {
    if (this.finder || !lib) return;
    this.finder = lib.findCreate({ show_local_sources: true, p_groups: null, p_extra_ips: null });
  }

  /** The NDI sources on the network right now. */
  async sources() {
    const ndi = await loadNdi(this.config().ndi.library);
    if (!ndi) return { error: loadError, sources: [] };
    const fresh = !this.finder;
    this.#ensureFinder();
    /* A finder that has only just started has heard nobody yet. */
    if (fresh) await new Promise((r) => setTimeout(r, 2000));
    return { sources: this.#list() };
  }

  #list() {
    if (!this.finder) return [];
    const count = [0];
    const ptr = lib.findSources(this.finder, count);
    if (!ptr || !count[0]) return [];
    const arr = lib.koffi.decode(ptr, lib.koffi.array(lib.source, count[0]));
    return arr.map((s) => ({ name: s.p_ndi_name, url: s.p_url_address }));
  }

  #tick() {
    const want = this.config().ndi.source;
    if (!want) return;
    if (!this.recv) {
      const hit = this.#list().find((s) => s.name === want) || this.#list().find((s) => s.name.toLowerCase().includes(want.toLowerCase()));
      if (!hit) return;
      this.recv = lib.recvCreate({
        source_to_connect_to: { p_ndi_name: hit.name, p_url_address: hit.url },
        color_format: COLOR_FASTEST,
        bandwidth: METADATA_ONLY,
        allow_video_fields: true,
        p_ndi_recv_name: 'automitti tally',
      });
      if (!this.recv) { this.error = `NDI refused a receiver for ${hit.name}`; this.emit('change'); return; }
      this.connectedTo = hit.name;
      this.sent = { program: null, preview: null };
      this.log(`NDI: tally receiver on ${hit.name}`);
    }
    /* Drain what the sender says back, so nothing queues. */
    for (let i = 0; i < 8; i += 1) {
      const frame = {};
      const type = lib.capture(this.recv, null, null, frame, 0);
      if (type === FRAME_METADATA) lib.freeMeta(this.recv, frame);
      else break;
    }
    const n = lib.connections(this.recv);
    if (n !== this.connections) {
      this.connections = n;
      if (n > 0) this.sent = { program: null, preview: null }; // resend after a (re)connect
      this.emit('change');
    }
    this.#push();
  }

  #dropReceiver() {
    if (this.recv && lib) {
      lib.setTally(this.recv, { on_program: false, on_preview: false });
      lib.recvDestroy(this.recv);
    }
    this.recv = null;
    this.connectedTo = null;
    this.connections = 0;
  }

  #push() {
    if (!this.recv || !lib) return;
    const id = this.switcher.mittiInput();
    const t = id == null ? { program: false, preview: false } : this.switcher.tallyOf(id);
    if (t.program === this.sent.program && t.preview === this.sent.preview) return;
    lib.setTally(this.recv, { on_program: t.program, on_preview: t.preview });
    this.sent = t;
    this.log(`NDI tally → ${t.program ? 'PROGRAM' : t.preview ? 'preview' : 'off'}`);
    this.emit('change');
  }

  snapshot() {
    const c = this.config().ndi;
    return {
      enabled: c.enabled,
      library: lib?.file || null,
      error: this.error,
      source: c.source,
      connectedTo: this.connectedTo,
      connections: this.connections,
      tally: this.sent,
    };
  }
}
