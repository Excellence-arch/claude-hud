'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const STATE_DIR = path.join(CLAUDE_HOME, 'ai-helper');
const EVENTS_FILE = path.join(STATE_DIR, 'events.jsonl');
const UI_STATE_FILE = path.join(STATE_DIR, 'ui-state.json');
const SETTINGS_FILE = path.join(CLAUDE_HOME, 'settings.json');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

module.exports = {
  CLAUDE_HOME, PROJECTS_DIR, STATE_DIR,
  EVENTS_FILE, UI_STATE_FILE, SETTINGS_FILE,
  ensureStateDir,
};
