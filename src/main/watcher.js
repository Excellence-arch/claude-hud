'use strict';
/**
 * Watches ~/.claude/projects for Claude Code transcripts and derives:
 *   - which sessions are alive
 *   - each one's current context-window fill
 *   - a rolling token total across all sessions
 *
 * Transcripts are append-only JSONL and can reach tens of MB, so every file
 * keeps a byte cursor and only newly appended bytes are ever parsed.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { PROJECTS_DIR } = require('./paths');
const {
  ACTIVE_WINDOW_MS, BUSY_WINDOW_MS, USAGE_WINDOW_MS,
  INITIAL_TAIL_BYTES, POLL_MS, contextLimitFor, DEFAULT_CONTEXT_LIMIT,
} = require('./config');

/**
 * One API response is written as several JSONL lines (thinking / text /
 * tool_use), and each line repeats the same `usage` object. Billing events are
 * therefore keyed by requestId so a single response is only counted once.
 */
class UsageLedger {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.events = [];        // { ts, key, billed }
    this.seen = new Map();   // key -> ts
  }

  add(ts, requestId, billed) {
    const key = requestId || `anon:${ts}:${billed}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, ts);
    this.events.push({ ts, key, billed });
    return true;
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop].ts < cutoff) drop++;
    if (drop > 0) {
      for (let i = 0; i < drop; i++) this.seen.delete(this.events[i].key);
      this.events.splice(0, drop);
    }
  }

  total(now = Date.now()) {
    this.prune(now);
    let sum = 0;
    for (const e of this.events) sum += e.billed;
    return sum;
  }

  /** Oldest event still inside the window, i.e. when the bar starts draining. */
  oldestTs() {
    return this.events.length ? this.events[0].ts : null;
  }

  /**
   * Token spend split into equal time buckets across the window, oldest first.
   * Drives the sparkline, which shows *when* the budget went rather than just
   * how much is left.
   */
  histogram(count = 24, now = Date.now()) {
    this.prune(now);
    const buckets = new Array(count).fill(0);
    const span = this.windowMs / count;
    const start = now - this.windowMs;
    for (const e of this.events) {
      let i = Math.floor((e.ts - start) / span);
      if (i < 0) i = 0;
      if (i >= count) i = count - 1;
      buckets[i] += e.billed;
    }
    return buckets;
  }
}

class SessionWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.projectsDir = opts.projectsDir || PROJECTS_DIR;
    this.files = new Map();     // absolute path -> cursor record
    this.sessions = new Map();  // sessionId -> session record
    this.ledger = new UsageLedger(USAGE_WINDOW_MS);
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- scanning ----------------------------------------------------------

  listTranscripts() {
    let projects;
    try {
      projects = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(this.projectsDir, p.name);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        out.push({ file: path.join(dir, name), project: p.name });
      }
    }
    return out;
  }

  scan() {
    const now = Date.now();
    for (const item of this.listTranscripts()) {
      let st;
      try { st = fs.statSync(item.file); } catch { continue; }
      const known = this.files.get(item.file);

      // Transcripts cold since before the active window are skipped entirely,
      // unless they are already being tracked.
      if (!known && now - st.mtimeMs > ACTIVE_WINDOW_MS) continue;
      if (known && st.size === known.size && st.mtimeMs === known.mtime) continue;

      try {
        this.readFile(item.file, item.project, st, known);
      } catch (err) {
        this.emit('warn', { file: item.file, error: err.message });
      }
    }
    this.emit('update', this.snapshot(now));
  }

  readFile(file, project, st, known) {
    let start;
    let pending = '';
    // A fresh seek lands at an arbitrary byte; a resume continues from a known
    // line boundary. The two cases handle the first line differently.
    const fresh = !known || st.size < known.size;
    if (fresh) {
      // New file, or one that was truncated or rewritten: restart from the tail.
      start = Math.max(0, st.size - INITIAL_TAIL_BYTES);
    } else {
      start = known.offset;
      pending = known.pending || '';
    }
    if (start > st.size) start = Math.max(0, st.size - INITIAL_TAIL_BYTES);

    let text = '';
    if (st.size > start) {
      const fd = fs.openSync(file, 'r');
      try {
        const len = st.size - start;
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, start);
        text = buf.slice(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }

    // Seeking into the middle of the file lands mid-line; drop that fragment.
    // Only on a fresh seek: when resuming, `start` is already a line boundary
    // and an empty `pending` is normal, so dropping here would eat a real line.
    if (fresh && start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }

    const lines = (pending + text).split('\n');
    const tail = lines.pop(); // may be incomplete; carried into the next read

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      this.ingest(entry, file, project);
    }

    this.files.set(file, {
      size: st.size,
      mtime: st.mtimeMs,
      offset: st.size,
      pending: tail,
    });
  }

  // ---- interpreting entries ----------------------------------------------

  ingest(entry, file, project) {
    const sessionId = entry.sessionId;
    if (!sessionId) return;

    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId, file, project,
        cwd: null, branch: null, model: null,
        lastTs: 0, firstTs: 0,
        contextTokens: 0,
        contextPeak: 0,
        billedTokens: 0,
        turns: 0,
      };
      this.sessions.set(sessionId, s);
    }

    const ts = Date.parse(entry.timestamp || '') || 0;
    if (ts) {
      if (ts > s.lastTs) s.lastTs = ts;
      if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
    }
    if (entry.cwd) s.cwd = entry.cwd;
    if (entry.gitBranch) s.branch = entry.gitBranch;

    const msg = entry.message;
    if (entry.type !== 'assistant' || !msg || !msg.usage) return;
    if (msg.model && !entry.isSidechain) s.model = msg.model;

    const u = msg.usage;
    const input = u.input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const output = u.output_tokens || 0;

    // The prompt was rebuilt from the cache, so input plus both cache figures
    // is the size of the context that was just sent.
    const context = input + cacheRead + cacheWrite;

    // Cache reads bill at a fraction of input, so the rolling bar tracks only
    // the tokens charged at a full rate.
    const billed = input + cacheWrite + output;

    const counted = this.ledger.add(ts || Date.now(), entry.requestId, billed);
    if (!counted) return; // another line of a response already accounted for

    s.billedTokens += billed;
    s.turns += 1;

    // A subagent runs its own context and must not overwrite the main thread.
    if (!entry.isSidechain && context > 0) {
      s.contextTokens = context;
      // The peak reveals how big this session's window really is; compaction
      // makes the current value drop, so it cannot be used for that.
      if (context > s.contextPeak) s.contextPeak = context;
    }
  }

  // ---- output ------------------------------------------------------------

  snapshot(now = Date.now()) {
    const sessions = [];
    for (const s of this.sessions.values()) {
      const idle = now - s.lastTs;
      if (idle > ACTIVE_WINDOW_MS) continue;
      const limit = contextLimitFor(s.model, s.contextPeak);
      sessions.push({
        sessionId: s.sessionId,
        project: s.project,
        cwd: s.cwd,
        label: s.cwd ? path.basename(s.cwd) : s.project,
        branch: s.branch && s.branch !== 'HEAD' ? s.branch : null,
        model: s.model,
        lastTs: s.lastTs,
        idleMs: idle,
        recentlyActive: idle < BUSY_WINDOW_MS,
        contextTokens: s.contextTokens,
        contextLimit: limit,
        contextPct: limit ? Math.min(1, s.contextTokens / limit) : 0,
        contextPeak: s.contextPeak,
        limitInferred: s.contextPeak > DEFAULT_CONTEXT_LIMIT,
        billedTokens: s.billedTokens,
        turns: s.turns,
        file: s.file,
      });
    }
    sessions.sort((a, b) => b.lastTs - a.lastTs);
    return {
      now,
      sessions,
      window: {
        totalTokens: this.ledger.total(now),
        windowMs: USAGE_WINDOW_MS,
        since: this.ledger.oldestTs(),
        buckets: this.ledger.histogram(24, now),
      },
    };
  }
}

module.exports = { SessionWatcher, UsageLedger };
