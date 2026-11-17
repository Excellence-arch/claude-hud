#!/usr/bin/env node
'use strict';
/**
 * Hook shim invoked by Claude Code. Appends one JSON line to
 * ~/.claude/ai-helper/events.jsonl describing what just happened, which is how
 * the HUD learns that a session is working, finished its turn, or is blocked
 * waiting for permission.
 *
 * Usage (from settings.json):  node <this file> <EventName>
 *
 * This runs inside Claude Code's own request path, so it must be fast, must
 * never write to stdout, and must always exit 0 -- a failing hook should never
 * be able to disrupt a session.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_EVENTS_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 800;

let done = false;

function write(stdin) {
  if (done) return;
  done = true;

  let payload = {};
  try {
    if (stdin && stdin.trim()) payload = JSON.parse(stdin);
  } catch {
    /* a malformed payload still produces a usable event */
  }

  const record = {
    ts: Date.now(),
    event: payload.hook_event_name || process.argv[2] || 'Unknown',
    sessionId: payload.session_id || null,
    cwd: payload.cwd || process.cwd(),
    message: typeof payload.message === 'string' ? payload.message : null,
    toolName: payload.tool_name || null,
    transcript: payload.transcript_path || null,
  };

  try {
    const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const dir = path.join(home, 'ai-helper');
    const file = path.join(dir, 'events.jsonl');
    fs.mkdirSync(dir, { recursive: true });

    // Keep the log bounded. Truncating is safe: the HUD holds state in memory
    // and detects the shrink, and consumed events have no further value.
    try {
      if (fs.statSync(file).size > MAX_EVENTS_BYTES) fs.truncateSync(file, 0);
    } catch {
      /* file does not exist yet */
    }

    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* a broken HUD must not break the session */
  }

  process.exit(0);
}

// The payload arrives on stdin. A synchronous read of fd 0 is unreliable on
// Windows pipes, so stdin is consumed as a stream, with a timeout in case the
// hook was invoked with no input at all.
try {
  if (process.stdin.isTTY) {
    write('');
  } else {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => write(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => write(''));
    const timer = setTimeout(() => write(Buffer.concat(chunks).toString('utf8')), STDIN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  }
} catch {
  write('');
}
