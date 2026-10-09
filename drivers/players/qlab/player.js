/*
 * QLab 5, as a player: one workspace, one cue list, and the cues in it of the
 * types that count as clips (Video unless told otherwise).
 *
 * QLab is a cue stack, not a playlist, so the player's words map like this:
 *
 *   current   the clip that is running or paused; when none is, the clip the
 *             playhead stands by on (the one a GO plays). A clip that has
 *             just run out stays current, at 0 left, for long enough for the
 *             rules to see it end.
 *   next      the first clip after that.
 *   play      resume the current clip if it is paused; otherwise GO the cue
 *             list (never a second GO while a clip runs — that would fire
 *             the next cue).
 *   pause     pause the running clip.
 *   rewind    stop the clip and stand the playhead back on it.
 *   stopnext  stop the clip. Its GO already moved the playhead on.
 *   next/prev move the playhead.
 *
 * What it knows comes from three places (docs/QLAB.md has the research):
 *   /update/…        pushed: playhead moves, and "cue X changed" on every
 *                    start, pause, stop and edit
 *   /cueLists        the cue lists, in order, with names, numbers and types
 *   valuesForKeys    a cue's duration, elapsed time and running/paused state —
 *                    polled every 100 ms while a clip runs, because QLab
 *                    pushes no time
 * Replies are matched by the uniqueID in their data, not by address: QLab
 * answers /cue/playhead/… as /cue/<number>/….
 */

import { EventEmitter } from 'node:events';
import { QLabLink } from './link.js';

/* What is asked of a clip. uniqueID first: every reply says whose it is. */
const VALUE_KEYS = JSON.stringify(['uniqueID', 'number', 'listName', 'type', 'currentDuration', 'actionElapsed', 'isRunning', 'isPaused', 'isActionRunning']);
const POLL_RUNNING_MS = 100;
const POLL_IDLE_MS = 500;
const HEARTBEAT_MS = 1000;
const ONLINE_WITHIN_MS = 4500;
const WORKSPACE_RETRY_MS = 2000;
/* A clip that leaves the running set with this little left has run out, not been stopped. */
const ENDED_WITHIN_SEC = 0.5;
/* How long a clip that ran out stays current at 0 left. The rules look for an end for 2 s. */
const HOLD_ENDED_MS = 2500;
/* QLab's lockout after a wrong passcode grows with each one: never hammer it. */
const BADPASS_RETRY_MS = 30000;
const DENIED_RETRY_MS = 5000;
/* A second GO this soon after one, before the first one's clip is seen running, is a double GO. */
const GO_GUARD_MS = 750;
const LIST_REFRESH_MS = 1000;

/* QLab's application-level messages, which must NOT be sent under /workspace/<id>/. */
const APP_MESSAGES = /^\/(version|workspaces|updates|alwaysReply|disconnect|udpReplyPort|forgetMeNot|udpKeepAlive|overrides|overrideWindow|toggleOverrideWindow|timecodeWindow|toggleTimecodeWindow|replyFormat|fontNames|fontFamiliesAndStyles|workingDirectory)(\/|$)/;

export class QLabPlayer extends EventEmitter {
  /**
   * @param {{settings: {host, port, workspace, passcode, cueList, cueTypes, fps}, log?: Function}} opts
   */
  constructor({ settings, log = () => {} }) {
    super();
    this.s = settings;
    this.log = log;
    this.types = new Set((settings.cueTypes || []).map((t) => t.toLowerCase()));
    this.link = new QLabLink({ host: settings.host, port: settings.port, log });
    this.phase = 'connecting'; // connecting → workspaces → joining → connected; locked after a refusal
    this.ws = null;            // { id, name, version }
    this.open = [];            // names of the open workspaces, for the error when ours is not one
    this.permissions = null;
    this.error = null;
    this.lists = new Map();    // id → { id, number, name, type, order: [cue ids, depth first] }
    this.cues = new Map();     // id → { id, number, name, type, list, top, seconds, elapsed, running, paused, actionRunning, at, startedAt }
    this.currentListId = null;
    this.playheads = new Map(); // list id → cue id | null
    this.active = new Set();   // QLab's runningOrPausedCues, every type
    this.ended = null;         // { id, at, completed } — the last clip to stop
    this.lastReplyAt = 0;
    this.lastPoll = 0;
    this.lastBeat = 0;
    this.lastGo = 0;
    this.wasOnline = false;
    this.retryAt = 0;
    this.askedAt = 0;
    this.denied = new Set();

    this.link.on('open', () => this.#onOpen());
    this.link.on('close', (why, was) => this.#onClose(why, was));
    this.link.on('reply', (r) => this.#onReply(r));
    this.link.on('update', (address, args) => this.#onUpdate(address, args));
  }

  async start() {
    this.link.start();
    this.timer = setInterval(() => this.#tick(), POLL_RUNNING_MS);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.listTimer);
    if (this.phase === 'connected') {
      this.link.send('/updates', [0]);
      this.link.send('/disconnect');
    }
    this.link.stop();
    this.phase = 'connecting';
  }

  /* ------------------------------------------------------------ the connection */

  #w(path) { return `/workspace/${this.ws.id}${path}`; }

  #send(path, args = []) {
    if (this.phase !== 'connected') return false;
    return this.link.send(this.#w(path), args);
  }

  #onOpen() {
    this.log(`QLab: connected to ${this.s.host}:${this.link.port}`);
    this.#askWorkspaces();
  }

  #onClose(why, was) {
    if (was) this.log(`QLab: ${why}`);
    this.phase = 'connecting';
    this.#forget();
    this.error = why;
    this.emit('change', 'offline');
  }

  /* The workspace is gone, or out of reach: none of what we knew of it can be shown. */
  #forget() {
    clearTimeout(this.listTimer);
    this.listTimer = null;
    this.ws = null;
    this.permissions = null;
    this.lists.clear();
    this.cues.clear();
    this.playheads.clear();
    this.currentListId = null;
    this.active.clear();
    this.ended = null;
  }

  #askWorkspaces() {
    this.phase = 'workspaces';
    this.askedAt = Date.now();
    this.listed = false;
    this.link.send('/workspaces');
  }

  #onWorkspaces(list) {
    if (this.phase !== 'workspaces' || !Array.isArray(list)) return;
    this.listed = true;
    const bare = (s) => String(s ?? '').trim().toLowerCase().replace(/\.qlab\d*$/, '');
    const want = bare(this.s.workspace);
    this.open = list.map((w) => w.displayName);
    const ws = want ? list.find((w) => bare(w.uniqueID) === want || bare(w.displayName) === want) : list[0];
    if (!ws) {
      this.#fail(list.length
        ? `QLab has no workspace called “${this.s.workspace}” open (open: ${this.open.join(', ')})`
        : 'QLab is running but has no workspace open');
      return;
    }
    this.ws = { id: ws.uniqueID, name: ws.displayName, version: ws.version };
    this.#join();
  }

  #join() {
    this.phase = 'joining';
    this.askedAt = Date.now();
    this.link.send(this.#w('/connect'), this.s.passcode ? [String(this.s.passcode)] : []);
  }

  #onConnect(status, data) {
    if (this.phase !== 'joining') return;
    const name = `“${this.ws.name}”`;
    if (status === 'denied') {
      /* QLab's lockout after a wrong passcode: even the right one is refused for a while. */
      return this.#lock(DENIED_RETRY_MS, `QLab is refusing to connect for a moment after a wrong passcode for ${name}`);
    }
    if (status !== 'ok') return this.#askWorkspaces(); // the workspace closed under us
    if (data === 'badpass') {
      return this.#lock(BADPASS_RETRY_MS, this.s.passcode
        ? `QLab refused the passcode for ${name}`
        : `${name} needs a passcode: Workspace Settings → Network → OSC Access`);
    }
    /* "ok:view|edit|control". A bare "ok" (older QLab) says nothing, so assume all. */
    const text = String(data ?? '');
    this.permissions = text.includes(':') ? text.slice(text.indexOf(':') + 1).split('|').filter(Boolean) : ['view', 'edit', 'control'];
    if (!this.permissions.length) {
      return this.#lock(BADPASS_RETRY_MS, `${name} gives connections without a passcode no access: enter its passcode (Workspace Settings → Network → OSC Access)`);
    }
    this.phase = 'connected';
    this.error = this.permissions.includes('control') ? null : `the passcode for ${name} can't control it (it has ${this.permissions.join(', ')}), so the rules can't drive it`;
    this.denied.clear();
    /* Whatever moved while we were away is asked again. */
    this.playheads.clear();
    this.currentListId = null;
    this.log(`QLab: joined ${name} (${this.permissions.join(', ')})`);
    this.link.send('/updates', [1]);
    this.#send('/cueLists');
    this.#send('/currentCueListID');
    this.#send('/runningOrPausedCues');
    this.emit('change', 'online');
  }

  #lock(ms, why) {
    this.phase = 'locked';
    this.retryAt = Date.now() + ms;
    this.#fail(why);
  }

  #fail(why) {
    if (why !== this.error) this.log(`QLab: ${why}`);
    this.error = why;
    this.emit('change', 'error');
  }

  #tick() {
    const now = Date.now();
    const online = this.#online(now);
    if (online !== this.wasOnline) { this.wasOnline = online; this.emit('change', 'online'); }
    if (this.ended && now - this.ended.at > HOLD_ENDED_MS && !this.ended.released) {
      this.ended.released = true;
      this.emit('change', 'ended');
    }
    if (!this.link.open) return;
    if (this.phase === 'workspaces' && now - this.askedAt > WORKSPACE_RETRY_MS) {
      /* QLab answers /workspaces with nothing at all while no workspace is open. */
      if (!this.listed) this.#fail('QLab is running but has no workspace open');
      this.#askWorkspaces();
    } else if (this.phase === 'joining' && now - this.askedAt > WORKSPACE_RETRY_MS) {
      this.#askWorkspaces();
    } else if (this.phase === 'locked' && now >= this.retryAt) {
      this.#askWorkspaces();
    } else if (this.phase === 'connected') {
      if (now - this.lastBeat >= HEARTBEAT_MS) {
        this.lastBeat = now;
        this.#send('/currentCueListID');
      }
      const live = this.#live();
      if (now - this.lastPoll >= (live.some((c) => c.running) ? POLL_RUNNING_MS : POLL_IDLE_MS)) this.#poll(now);
    }
  }

  #poll(now = Date.now()) {
    this.lastPoll = now;
    this.#send('/runningOrPausedCues');
    for (const id of this.active) {
      const c = this.cues.get(id);
      if (!c || this.#follows(c)) this.#ask(id);
    }
  }

  #ask(id) { this.#send(`/cue_id/${id}/valuesForKeys`, [VALUE_KEYS]); }

  #online(now = Date.now()) {
    return this.phase === 'connected' && this.link.open && now - this.lastReplyAt < ONLINE_WITHIN_MS;
  }

  /* ------------------------------------------------------------ what QLab says */

  #onReply({ address, status, data }) {
    this.lastReplyAt = Date.now();
    if (address === '/workspaces') return this.#onWorkspaces(data);
    if (!this.ws) return;
    const prefix = `/workspace/${this.ws.id}`;
    if (!address.startsWith(prefix)) return;
    const path = address.slice(prefix.length);
    if (path === '/connect') return this.#onConnect(status, data);
    if (status === 'denied') {
      if (!this.denied.has(path)) { this.denied.add(path); this.log(`QLab refused ${path}: this passcode lacks the permission`); }
      return;
    }
    if (status !== 'ok') return;
    if (path === '/cueLists') return this.#onCueLists(data);
    if (path === '/currentCueListID') return this.#onCurrentList(data);
    if (path === '/runningOrPausedCues') return this.#onActive(data);
    const ph = /^\/cue_id\/([^/]+)\/playheadID$/.exec(path);
    if (ph) return this.#setPlayhead(ph[1], data === 'none' ? null : data || null);
    if (path.endsWith('/valuesForKeys') && data?.uniqueID) this.#onValues(data);
  }

  #onUpdate(address, args) {
    if (this.phase !== 'connected') return;
    const prefix = `/update/workspace/${this.ws.id}`;
    if (!address.startsWith(prefix)) return;
    const path = address.slice(prefix.length);
    if (path === '/disconnect') {
      this.log(`QLab: “${this.ws.name}” closed`);
      this.#forget();
      this.#askWorkspaces();
      this.emit('change', 'offline');
      return;
    }
    if (path === '') return this.#refreshLists();
    const ph = /^\/cueList\/([^/]+)\/playbackPosition$/.exec(path);
    if (ph) return this.#setPlayhead(ph[1], args[0] || null);
    const cue = /^\/cue_id\/([^/]+)$/.exec(path);
    if (!cue) return; // /dashboard and the like
    const id = cue[1];
    if (id === '__root__' || this.lists.has(id) || !this.cues.has(id)) this.#refreshLists();
    else if (this.#follows(this.cues.get(id))) this.#ask(id);
    /* Something started, paused or stopped: look now rather than at the next poll. */
    this.lastPoll = 0;
  }

  /* QLab says a list changed on every start and stop, so a refresh waits for a quiet moment. */
  #refreshLists() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      this.#send('/cueLists');
    }, LIST_REFRESH_MS);
  }

  #onCueLists(data) {
    if (!Array.isArray(data)) return;
    const seen = new Set();
    this.lists.clear();
    const walk = (parent, list, top, order) => {
      for (const d of parent.cues || []) {
        const c = this.cues.get(d.uniqueID) || { id: d.uniqueID, running: false, paused: false };
        c.number = d.number || '';
        c.name = d.listName || d.name || c.name || '';
        c.type = d.type;
        c.list = list;
        c.top = top || d.uniqueID;
        this.cues.set(c.id, c);
        seen.add(c.id);
        order.push(c.id);
        walk(d, list, c.top, order);
      }
    };
    for (const l of data) {
      const order = [];
      walk(l, l.uniqueID, null, order);
      this.lists.set(l.uniqueID, { id: l.uniqueID, number: l.number || '', name: l.listName || l.name || '', type: l.type, order });
    }
    for (const id of this.cues.keys()) if (!seen.has(id) && !this.active.has(id)) this.cues.delete(id);
    /* Durations aren't in /cueLists: ask each clip once. */
    for (const c of this.cues.values()) if (this.#follows(c) && c.seconds == null) this.#ask(c.id);
    const list = this.#list();
    if (list && !this.playheads.has(list.id)) this.#send(`/cue_id/${list.id}/playheadID`);
    this.emit('change', 'cues');
  }

  #onCurrentList(id) {
    if (!id || id === this.currentListId) return;
    this.currentListId = id;
    if (!this.lists.has(id)) this.#refreshLists();
    else if (!this.playheads.has(id)) this.#send(`/cue_id/${id}/playheadID`);
    this.emit('change', 'list');
  }

  #setPlayhead(list, id) {
    this.playheads.set(list, id);
    this.emit('change', 'playhead');
  }

  #onActive(data) {
    if (!Array.isArray(data)) return;
    const now = new Set();
    const walk = (arr) => { for (const d of arr) { now.add(d.uniqueID); if (!this.cues.has(d.uniqueID)) this.#refreshLists(); walk(d.cues || []); } };
    walk(data);
    for (const id of now) {
      const c = this.cues.get(id);
      if (!this.active.has(id) && (!c || this.#follows(c))) this.#ask(id);
    }
    for (const id of this.active) {
      const c = this.cues.get(id);
      if (!now.has(id) && c && (c.running || c.paused)) this.#stopped(c);
    }
    this.active = now;
    this.emit('change', 'active');
  }

  #onValues(d) {
    const c = this.cues.get(d.uniqueID) || { id: d.uniqueID, running: false, paused: false };
    this.cues.set(c.id, c);
    if (typeof d.number === 'string') c.number = d.number;
    if (d.listName) c.name = d.listName;
    if (d.type) c.type = d.type;
    if (Number.isFinite(d.currentDuration)) c.seconds = d.currentDuration;
    if ('isRunning' in d) {
      const was = c.running || c.paused;
      const is = !!d.isRunning || !!d.isPaused;
      if (was && !is) {
        /* QLab resets a cue the moment it stops: elapsed reads 0 whether it
           ran out or was stopped. What it was doing a moment ago says which. */
        this.#stopped(c);
      } else if (is) {
        if (!was) { c.startedAt = Date.now(); this.goPending = false; }
        c.running = !!d.isRunning;
        c.paused = !!d.isPaused;
        c.actionRunning = d.isActionRunning !== false;
        c.elapsed = Number(d.actionElapsed) || 0;
        c.at = Date.now();
      }
    }
    this.emit('change', 'values');
  }

  #stopped(c) {
    const now = Date.now();
    const left = c.seconds == null ? null
      : c.seconds - (c.elapsed || 0) - (c.running && c.actionRunning ? (now - (c.at || now)) / 1000 : 0);
    const completed = c.running && left != null && left <= ENDED_WITHIN_SEC;
    c.running = false;
    c.paused = false;
    c.elapsed = completed ? c.seconds : 0;
    c.at = now;
    this.ended = { id: c.id, at: now, completed };
  }

  /* ------------------------------------------------------------ reading the model */

  #follows(c) {
    return !!c && (this.types.size ? this.types.has(String(c.type).toLowerCase()) : !/^(cue list|cart|group)$/i.test(c.type || ''));
  }

  #list() {
    const want = String(this.s.cueList || '').trim().toLowerCase();
    if (!want) return this.lists.get(this.currentListId) || null;
    for (const l of this.lists.values()) {
      if (l.id.toLowerCase() === want || (l.number && l.number.toLowerCase() === want) || l.name.toLowerCase() === want) return l;
    }
    return null;
  }

  #live() {
    const out = [];
    for (const id of this.active) {
      const c = this.cues.get(id);
      if (c && (c.running || c.paused) && this.#follows(c)) out.push(c);
    }
    return out;
  }

  /** The first clip in `list` from `id` on (or after it). */
  #clipFrom(list, id, inclusive) {
    if (!list || !id) return null;
    const at = list.order.indexOf(id);
    if (at < 0) return null;
    for (let i = inclusive ? at : at + 1; i < list.order.length; i += 1) {
      const c = this.cues.get(list.order[i]);
      if (this.#follows(c)) return c;
    }
    return null;
  }

  /** { cue, live, ended } — what the display and the rules call current. */
  #current(list = this.#list()) {
    const live = this.#live();
    if (live.length) {
      /* Several clips at once: the running one, the latest started. */
      live.sort((a, b) => (b.running - a.running) || ((b.startedAt || 0) - (a.startedAt || 0)));
      return { cue: live[0], live: true };
    }
    if (this.ended?.completed && Date.now() - this.ended.at <= HOLD_ENDED_MS) {
      const cue = this.cues.get(this.ended.id);
      if (cue) return { cue, ended: true };
    }
    const standby = list ? this.#clipFrom(list, this.playheads.get(list.id), true) : null;
    return standby ? { cue: standby } : null;
  }

  /* ------------------------------------------------------------ commands */

  /** Any OSC message to QLab — put under this workspace unless it is an application message. */
  command(address, args = []) {
    if (!this.link.open) return false;
    const routed = address.startsWith('/workspace/') || APP_MESSAGES.test(address) || !this.ws ? address : this.#w(address);
    return this.link.send(routed, args);
  }

  async act(action) {
    if (!this.#online()) throw new Error('QLab is not connected');
    const list = this.#list();
    const cur = this.#current(list);
    const clip = cur?.live ? cur.cue : null;
    const go = () => {
      if (this.goPending && Date.now() - this.lastGo < GO_GUARD_MS) { this.log('QLab: a second GO before the first one\'s clip started was not sent'); return; }
      this.lastGo = Date.now();
      this.goPending = true;
      this.#send(list ? `/cue_id/${list.id}/go` : '/go');
    };
    const playhead = (to) => this.#send(list ? `/cue_id/${list.id}/playhead/${to}` : `/playhead/${to}`);
    switch (action) {
      case 'play':
        if (clip?.paused) this.#send(`/cue_id/${clip.id}/resume`);
        else if (!clip) go();
        break;
      case 'pause':
        if (clip?.running) this.#send(`/cue_id/${clip.id}/pause`);
        break;
      case 'rewind':
      case 'stoprewind':
        if (clip) {
          this.#send(`/cue_id/${clip.id}/stop`);
          /* The playhead stands on a cue of the list, never inside a group. */
          if (list && clip.list === list.id) this.#send(`/cue_id/${list.id}/playheadID`, [clip.top || clip.id]);
        }
        break;
      case 'stopnext':
        if (clip) this.#send(`/cue_id/${clip.id}/stop`);
        break;
      case 'next': playhead('next'); break;
      case 'prev': playhead('previous'); break;
      default: break;
    }
    this.lastPoll = 0;
  }

  /* ------------------------------------------------------------ the snapshot */

  snapshot() {
    const now = Date.now();
    const online = this.#online(now);
    const list = this.#list();
    const clips = list ? list.order.map((id) => this.cues.get(id)).filter((c) => this.#follows(c)) : [];
    const index = new Map(clips.map((c, i) => [c.id, i + 1]));
    const cur = this.#current(list);
    const c = cur?.cue || null;
    const ph = list ? this.playheads.get(list.id) : null;
    let next = this.#clipFrom(list, ph, true);
    if (c && (!next || next.id === c.id)) next = this.#clipFrom(list, c.id, false);
    if (next && c && next.id === c.id) next = null;

    const seconds = c?.seconds ?? null;
    const elapsed = c ? (cur.live || cur.ended ? c.elapsed || 0 : 0) : null;
    const remaining = seconds != null && elapsed != null ? Math.max(0, seconds - elapsed) : null;
    /* A cue with no name and no file has an empty list name in QLab. */
    const name = (x) => x.name || [x.type, x.number].filter(Boolean).join(' ') || null;
    const describe = (x) => x && { id: x.id, name: name(x), number: x.number || null, index: index.get(x.id) ?? null, trtSec: x.seconds ?? null };
    const state = { connecting: 'connecting', workspaces: 'finding the workspace', joining: 'connecting to the workspace', locked: 'refused', connected: online ? 'connected' : 'not answering' }[this.phase];
    const kinds = this.types.size ? [...this.types].join('/') : 'all';
    return {
      online,
      error: this.error,
      playing: !!(cur?.live && c.running && c.actionRunning),
      playhead: seconds ? Math.min(1, (elapsed || 0) / seconds) : 0,
      fps: this.s.fps || 25,
      updatedAt: cur?.live ? c.at || null : null,
      current: describe(c) || { name: null, index: null, trtSec: null },
      next: describe(next) || { name: null, index: null, trtSec: null },
      elapsedSec: elapsed,
      remainingSec: remaining,
      cues: clips.map((x) => ({ index: index.get(x.id), name: name(x), number: x.number || null, seconds: x.seconds ?? null })),
      summary: [
        this.s.host,
        this.ws ? `“${this.ws.name}”` : null,
        state,
        list ? `${list.name || 'cue list'} · ${clips.length} ${kinds} cue${clips.length === 1 ? '' : 's'}` : (this.phase === 'connected' && this.s.cueList ? `no cue list “${this.s.cueList}”` : null),
      ].filter(Boolean).join(' · '),
      detail: {
        workspace: this.ws,
        openWorkspaces: this.open,
        permissions: this.permissions,
        cueList: list && { id: list.id, number: list.number, name: list.name },
        playheadCue: ph ? (this.cues.get(ph)?.name ?? ph) : null,
        running: this.#live().map(name),
        link: { ...this.link.stats, connected: this.link.open },
      },
    };
  }
}
