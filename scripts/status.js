#!/usr/bin/env node
'use strict';
/**
 * Prints the same data the HUD shows, in the terminal.
 *
 *   node scripts/status.js           one snapshot
 *   node scripts/status.js --watch   refresh until Ctrl+C
 *
 * Useful for checking the data layer without launching the window.
 */
const { SessionWatcher } = require('../src/main/watcher');
const { EventBridge, STATES } = require('../src/main/events');
const { SessionRegistry } = require('../src/main/sessions');
const { mergeSessions } = require('../src/main/merge');
const { DEFAULT_WINDOW_BUDGET } = require('../src/main/config');

const WATCH = process.argv.includes('--watch');

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  blue: s => `\x1b[36m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  amber: s => `\x1b[33m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
};

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function bar(pct, width = 18) {
  const filled = Math.round(Math.min(1, Math.max(0, pct)) * width);
  const glyph = '#'.repeat(filled) + '.'.repeat(width - filled);
  if (pct >= 0.9) return C.red(glyph);
  if (pct >= 0.7) return C.amber(glyph);
  return C.blue(glyph);
}

function colourState(state) {
  switch (state) {
    case STATES.WORKING: return C.blue('working');
    case STATES.READY: return C.green('your turn');
    case STATES.PERMISSION: return C.red('NEEDS YOU');
    case STATES.IDLE: return C.amber('waiting');
    default: return C.dim(state);
  }
}

function render(merged, snap, hooksInstalled) {
  const lines = [];
  lines.push('');
  lines.push(C.bold('  Claude Code sessions'));
  lines.push('');

  if (merged.sessions.length === 0) {
    lines.push(C.dim('  no sessions currently open'));
  }

  for (const s of merged.sessions) {
    const name = (s.label || '').slice(0, 22).padEnd(22);
    const pct = `${Math.round(s.contextPct * 100)}%`.padStart(4);
    lines.push(`  ${name} ${bar(s.contextPct)} ${pct}  ${colourState(s.state)}`);

    const meta = [
      s.model || 'starting',
      s.branch ? `branch ${s.branch}` : null,
      `${s.turns} turns`,
      `${tokens(s.contextTokens)}/${s.limitInferred ? '~' : ''}${tokens(s.contextLimit)} ctx`,
      `pid ${s.pid}`,
    ].filter(Boolean).join('  ');
    lines.push(C.dim(`  ${' '.repeat(22)} ${meta}`));
    if (s.stateMessage) lines.push(C.dim(`  ${' '.repeat(22)} ${s.stateMessage}`));
  }

  const budget = DEFAULT_WINDOW_BUDGET;
  const total = snap.window.totalTokens;
  lines.push('');
  lines.push(`  ${'last 5h'.padEnd(22)} ${bar(total / budget)} ${tokens(total)} / ${tokens(budget)}`);
  if (!hooksInstalled) {
    lines.push('');
    lines.push(C.amber('  hooks not installed - run: npm run install-hooks'));
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const bridge = new EventBridge();
  bridge.start();
  const watcher = new SessionWatcher();
  const registry = new SessionRegistry();

  const show = () => {
    const snap = watcher.snapshot();
    const merged = mergeSessions(registry.list(), snap, bridge.snapshot());
    const out = render(merged, snap, bridge.isInstalled());
    if (WATCH) process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(out + '\n');
  };

  watcher.scan();
  show();

  if (!WATCH) {
    bridge.stop();
    return;
  }
  watcher.on('update', show);
  watcher.start();
  bridge.on('change', show);
}

main();
