'use strict';
/**
 * Reads Claude Code's own live session registry: ~/.claude/sessions/<pid>.json.
 *
 * This is the authoritative answer to "which sessions exist right now", which
 * neither transcripts nor hooks can give:
 *
 *   - transcripts only show that a session *was* writing, so a closed session
 *     looks identical to an idle one;
 *   - `SessionEnd` turns out never to fire in practice (observed: many
 *     SessionStart events, zero SessionEnd), so a stopped session would keep
 *     whatever state it last reported -- showing "working" forever.
 *
 * Each file carries a `status` field ("busy" / "idle") that Claude Code keeps
 * current, plus the pid, so a session that was killed can be detected.
 */
const fs = require('fs');
const path = require('path');

const { CLAUDE_HOME } = require('./paths');

const SESSIONS_DIR = path.join(CLAUDE_HOME, 'sessions');

/** Registry status values, mapped to what the HUD displays. */
const STATUS = {
  BUSY: 'busy',
  IDLE: 'idle',
};

/**
 * Whether a pid is still running. EPERM means the process exists but belongs to
 * another user, which still counts as alive.
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

class SessionRegistry {
  constructor(opts = {}) {
    this.dir = opts.dir || SESSIONS_DIR;
  }

  /** Live sessions, newest activity first. */
  list() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    } catch {
      return [];
    }

    const out = [];
    for (const name of files) {
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
      } catch {
        continue; // mid-write or malformed; it will be read again next tick
      }
      if (!rec.sessionId) continue;
      // A leftover file from a crashed session still lists its pid, so
      // liveness has to be checked rather than trusted.
      if (!isAlive(rec.pid)) continue;

      out.push({
        sessionId: rec.sessionId,
        pid: rec.pid,
        cwd: rec.cwd || null,
        status: rec.status || null,
        name: rec.name || null,
        entrypoint: rec.entrypoint || null,
        kind: rec.kind || null,
        startedAt: rec.startedAt || null,
        updatedAt: rec.updatedAt || rec.startedAt || 0,
        statusUpdatedAt: rec.statusUpdatedAt || rec.updatedAt || 0,
      });
    }

    out.sort((a, b) => (b.statusUpdatedAt || 0) - (a.statusUpdatedAt || 0));
    return out;
  }

  /** Keyed by sessionId, for joining against transcript and hook data. */
  byId() {
    const map = {};
    for (const s of this.list()) map[s.sessionId] = s;
    return map;
  }
}

module.exports = { SessionRegistry, STATUS, isAlive, SESSIONS_DIR };
