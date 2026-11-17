#!/usr/bin/env node
'use strict';
/**
 * Merges the HUD hooks into ~/.claude/settings.json.
 *
 *   node scripts/install-hooks.js            install / repair
 *   node scripts/install-hooks.js --remove   remove them again
 *
 * The file belongs to the user, so edits are surgical: existing hooks and all
 * other settings are preserved, a timestamped backup is written first, and our
 * own entries are recognised by the hook script path.
 */
const fs = require('fs');
const path = require('path');

const { SETTINGS_FILE, CLAUDE_HOME } = require('../src/main/paths');

/**
 * The hook script to register. `--script <path>` lets the installed copy of the
 * app point Claude Code at itself, so the hooks keep working even if this
 * checkout is moved or deleted.
 */
function resolveHookScript() {
  const i = process.argv.indexOf('--script');
  if (i !== -1 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return path.join(__dirname, '..', 'hooks', 'claude-hook.js');
}

const HOOK_SCRIPT = resolveHookScript();

// Identifies our entries wherever the app is installed, so a reinstall replaces
// them instead of stacking up. Deliberately not tied to the repo path.
const MARKER = 'claude-hook.js';

// Events the HUD needs. PreToolUse is deliberately excluded: it fires on every
// single tool call and the transcript already reveals that work is happening.
const EVENTS = ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart', 'SessionEnd'];

function commandFor(event) {
  return `node "${HOOK_SCRIPT}" ${event}`;
}

function isOurs(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(h => typeof h.command === 'string' && h.command.includes(MARKER));
}

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { settings: JSON.parse(raw), existed: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, existed: false };
    // A malformed settings file must not be clobbered.
    throw new Error(`Could not parse ${SETTINGS_FILE}: ${err.message}`);
  }
}

function backup() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(CLAUDE_HOME, `settings.json.ai-helper-backup-${stamp}`);
    fs.copyFileSync(SETTINGS_FILE, dest);
    return dest;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function install() {
  const { settings } = readSettings();
  const saved = backup();

  settings.hooks = settings.hooks || {};
  let added = 0;
  let refreshed = 0;

  for (const event of EVENTS) {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const mine = list.filter(isOurs);
    const others = list.filter(e => !isOurs(e));
    const entry = { hooks: [{ type: 'command', command: commandFor(event) }] };

    if (mine.length === 0) added++;
    else refreshed++;

    // Keep the user's own hooks, replace only ours (handles a moved checkout).
    settings.hooks[event] = [...others, entry];
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  console.log(`Hooks written to ${SETTINGS_FILE}`);
  console.log(`  events: ${EVENTS.join(', ')}`);
  console.log(`  added: ${added}, refreshed: ${refreshed}`);
  if (saved) console.log(`  backup: ${saved}`);
  console.log('\nRestart any running Claude Code session to pick these up.');
}

function remove() {
  const { settings, existed } = readSettings();
  if (!existed || !settings.hooks) {
    console.log('Nothing to remove.');
    return;
  }
  const saved = backup();
  let removed = 0;

  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter(e => !isOurs(e));
    removed += list.length - kept.length;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(`Removed ${removed} hook entr${removed === 1 ? 'y' : 'ies'} from ${SETTINGS_FILE}`);
  if (saved) console.log(`  backup: ${saved}`);
}

function main() {
  if (!fs.existsSync(HOOK_SCRIPT)) {
    console.error(`Hook script missing: ${HOOK_SCRIPT}`);
    process.exit(1);
  }
  if (process.argv.includes('--remove')) remove();
  else install();
}

main();
