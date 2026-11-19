'use strict';
/**
 * Reconciles the three data sources into what the HUD renders.
 *
 * Each answers a different question, and none is sufficient alone:
 *
 *   registry   which sessions exist right now, and busy vs idle  (authoritative)
 *   transcript how many tokens, and proof of forward progress
 *   hooks      that a session is blocked waiting for you
 *
 * The registry drives the list: a session that has been closed vanishes from
 * it, which is the only reliable way to stop showing it -- `SessionEnd` does
 * not fire in practice.
 *
 * Kept free of Electron imports so it can be tested headlessly.
 */
const { STATES } = require('./events');
const { STATUS } = require('./sessions');
const { contextLimitFor } = require('./config');

// How far a transcript must advance past a hook event before the session counts
// as resumed. Guards against the tool_use line that *precedes* a permission
// prompt being mistaken for work done after it.
const RESUME_GRACE_MS = 1500;

/** Base state from the registry, before any permission overlay. */
function baseState(reg) {
  if (reg.status === STATUS.BUSY) return STATES.WORKING;
  if (reg.status === STATUS.IDLE) return STATES.READY;
  return STATES.READY;
}

/**
 * A pending prompt stays an alert until there is positive evidence the session
 * moved on. Registry status is deliberately *not* used as that evidence: a
 * session blocked on a prompt may legitimately report either busy or idle, so
 * trusting it could silently discard the alert this whole tool exists for.
 * Transcript progress is unambiguous.
 */
function resolveState(reg, stats, hook) {
  const base = baseState(reg);
  if (!hook) return base;
  if (hook.state !== STATES.PERMISSION && hook.state !== STATES.IDLE) return base;

  const progressed = stats && stats.lastTs > hook.ts + RESUME_GRACE_MS;
  if (progressed) return base;

  // An idle nudge and an idle registry say the same thing; prefer the
  // registry's wording and keep the alert for genuine permission prompts.
  if (hook.state === STATES.IDLE && base === STATES.READY) return STATES.READY;
  return hook.state;
}

function mergeSessions(registry, snapshot, hookStates, now = Date.now()) {
  const stats = {};
  for (const s of (snapshot && snapshot.sessions) || []) stats[s.sessionId] = s;

  const sessions = [];
  for (const reg of registry) {
    const t = stats[reg.sessionId];
    const hook = hookStates[reg.sessionId];
    const state = resolveState(reg, t, hook);

    const contextTokens = t ? t.contextTokens : 0;
    const contextPeak = t ? t.contextPeak : 0;
    const model = t ? t.model : null;
    const limit = contextLimitFor(model, contextPeak);

    sessions.push({
      sessionId: reg.sessionId,
      pid: reg.pid,
      cwd: reg.cwd || (t ? t.cwd : null),
      // The registry's own name ("ai-helper-43") is what Claude Code shows, so
      // it is the least surprising label; fall back to the folder.
      label: reg.name || (t ? t.label : null) || 'session',
      entrypoint: reg.entrypoint,
      branch: t ? t.branch : null,
      model,
      state,
      stateMessage: hook ? hook.message : null,
      stateTs: hook ? hook.ts : (reg.statusUpdatedAt || now),
      needsAttention: state === STATES.PERMISSION,
      contextTokens,
      contextLimit: limit,
      contextPct: limit ? Math.min(1, contextTokens / limit) : 0,
      limitInferred: t ? t.limitInferred : false,
      billedTokens: t ? t.billedTokens : 0,
      turns: t ? t.turns : 0,
      lastTs: t ? t.lastTs : reg.updatedAt,
      hasTranscript: !!t,
      // Drill-down: the agent map, the live step, and the steps already taken.
      // A session whose transcript has not been read yet simply has none yet.
      activity: (t && t.activity) || { events: [], agents: [], current: null, runningAgents: 0 },
    });
  }

  return {
    now,
    sessions,
    attention: sessions.filter(s => s.needsAttention),
  };
}

module.exports = { mergeSessions, resolveState, RESUME_GRACE_MS };
