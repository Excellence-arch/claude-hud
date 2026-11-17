'use strict';
/**
 * Tails the hook event log and turns it into a per-session state.
 *
 * Transcripts say what a session has done; hooks say what it is doing right
 * now -- in particular whether it is blocked on a permission prompt, which
 * never appears in a transcript.
 */
const fs = require('fs');
const { EventEmitter } = require('events');

const { EVENTS_FILE, ensureStateDir } = require('./paths');

const STATES = {
  WORKING: 'working',     // Claude is mid-turn
  READY: 'ready',         // turn finished, waiting on you
  PERMISSION: 'permission', // blocked on an approval prompt
  IDLE: 'idle',           // nudging you for input
  ENDED: 'ended',
};

const POLL_MS = 400; // permission prompts should surface effectively instantly

// On startup the tail of the log is replayed, so a session that is *already*
// sitting on a permission prompt is reported instead of being missed until it
// happens to emit another event. Hook states for sessions the watcher no longer
// considers active are never rendered, so replaying stale lines is harmless.
const REPLAY_BYTES = 256 * 1024;

/** Notification covers both approval prompts and idle nudges. */
function classifyNotification(message) {
  const m = (message || '').toLowerCase();
  if (m.includes('permission') || m.includes('approve') || m.includes('allow')) {
    return STATES.PERMISSION;
  }
  if (m.includes('waiting') || m.includes('idle')) return STATES.IDLE;
  // Anything else still wants attention; treat it as a prompt rather than drop it.
  return STATES.PERMISSION;
}

class EventBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.file = opts.file || EVENTS_FILE;
    this.offset = 0;
    this.pending = '';
    this.states = new Map(); // sessionId -> { state, message, ts, toolName, cwd }
    this.timer = null;
    this.installed = false;
    this.dropFragment = false;
  }

  start() {
    if (this.timer) return;
    ensureStateDir();
    try {
      const size = fs.statSync(this.file).size;
      this.offset = Math.max(0, size - REPLAY_BYTES);
      // Seeking into the middle of the log lands mid-line.
      this.dropFragment = this.offset > 0;
    } catch {
      this.offset = 0;
      this.dropFragment = false;
    }
    this.poll(); // replay before the first tick, so startup state is immediate
    this.timer = setInterval(() => this.poll(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    let st;
    try {
      st = fs.statSync(this.file);
      this.installed = true;
    } catch {
      return; // hooks not installed yet, or no event has fired
    }

    if (st.size < this.offset) {
      // The hook shim truncated the log.
      this.offset = 0;
      this.pending = '';
    }
    if (st.size === this.offset) return;

    let text = '';
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = st.size - this.offset;
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, this.offset);
      text = buf.slice(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    this.offset = st.size;

    if (this.dropFragment) {
      this.dropFragment = false;
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }

    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop();

    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (this.apply(rec)) changed = true;
    }
    if (changed) this.emit('change', this.snapshot());
  }

  apply(rec) {
    if (!rec.sessionId) return false;
    let state = null;

    switch (rec.event) {
      case 'UserPromptSubmit':
        state = STATES.WORKING;
        break;
      case 'Stop':
        state = STATES.READY;
        break;
      case 'Notification':
        state = classifyNotification(rec.message);
        break;
      case 'SessionEnd':
        state = STATES.ENDED;
        break;
      case 'SessionStart':
        state = STATES.READY;
        break;
      default:
        return false;
    }

    const prev = this.states.get(rec.sessionId);
    // Events are appended in order, but guard against a stale read anyway.
    if (prev && prev.ts > rec.ts) return false;

    this.states.set(rec.sessionId, {
      state,
      message: rec.message || null,
      toolName: rec.toolName || null,
      cwd: rec.cwd || null,
      ts: rec.ts,
    });

    if (state === STATES.PERMISSION) {
      this.emit('permission', { sessionId: rec.sessionId, message: rec.message, cwd: rec.cwd });
    }
    return !prev || prev.state !== state;
  }

  snapshot() {
    const out = {};
    for (const [id, v] of this.states) out[id] = v;
    return out;
  }

  /** True once at least one hook event has ever been seen. */
  isInstalled() {
    if (this.installed) return true;
    try { fs.statSync(this.file); this.installed = true; } catch { /* absent */ }
    return this.installed;
  }
}

module.exports = { EventBridge, STATES };
