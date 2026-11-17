'use strict';

// How far back a transcript may have been touched and still count as "active".
const ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000;

// A session is treated as "working" if its transcript grew within this window.
const BUSY_WINDOW_MS = 45 * 1000;

// Rolling window for the aggregate usage bar (matches Claude's 5h usage blocks).
const USAGE_WINDOW_MS = 5 * 60 * 60 * 1000;

// First read of a transcript only looks at the tail, so startup stays fast.
const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;

const POLL_MS = 2000;

// Starting assumption for a model's context window, by substring match on the
// model id. These are only a starting point -- see contextLimitFor.
const CONTEXT_LIMITS = [
  [/opus/i, 200000],
  [/sonnet/i, 200000],
  [/haiku/i, 200000],
  [/fable/i, 200000],
];
const DEFAULT_CONTEXT_LIMIT = 200000;

// Known context window sizes, smallest first. A session that demonstrably
// exceeds one tier must be running on a larger window.
const CONTEXT_TIERS = [200000, 500000, 1000000];

// Soft ceiling for the rolling 5h bar. Not an official number -- it is a personal
// budget so the bar means something. Override in ~/.claude/ai-helper/ui-state.json.
const DEFAULT_WINDOW_BUDGET = 3000000;

/**
 * The context window for a given model, corrected by what the session has
 * actually been observed to hold.
 *
 * Hard-coding a window is unreliable: model ids change and real sessions have
 * been seen holding well over 200k tokens. Rather than report a misleading
 * "full", a session that exceeds its assumed tier is promoted to the next known
 * tier, and beyond the largest tier the figure is rounded up so the bar stays
 * meaningful instead of pinned.
 */
function contextLimitFor(model, observedPeak = 0) {
  let limit = DEFAULT_CONTEXT_LIMIT;
  if (model) {
    for (const [re, value] of CONTEXT_LIMITS) {
      if (re.test(model)) { limit = value; break; }
    }
  }
  if (observedPeak <= limit) return limit;

  const tier = CONTEXT_TIERS.find(t => t >= observedPeak);
  if (tier) return tier;
  // Past every known tier: round up to the next 100k.
  return Math.ceil(observedPeak / 100000) * 100000;
}

module.exports = {
  ACTIVE_WINDOW_MS, BUSY_WINDOW_MS, USAGE_WINDOW_MS,
  INITIAL_TAIL_BYTES, POLL_MS,
  DEFAULT_CONTEXT_LIMIT, DEFAULT_WINDOW_BUDGET, CONTEXT_TIERS,
  contextLimitFor,
};
