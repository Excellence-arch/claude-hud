#!/usr/bin/env node
'use strict';
/**
 * Installs the packaged app on this machine.
 *
 *   node scripts/install-app.js              install (or upgrade in place)
 *   node scripts/install-app.js --no-startup skip the auto-start shortcut
 *   node scripts/install-app.js --remove     uninstall
 *
 * Steps:
 *   1. copy the packaged output into %LOCALAPPDATA%\Programs\ClaudeHUD
 *   2. add Start Menu and (by default) Startup shortcuts
 *   3. re-point Claude Code's hooks at the *installed* hook script, so the HUD
 *      keeps working even if this checkout is moved or deleted
 *
 * Everything lands under the user's own profile, so no admin rights are needed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const APP_NAME = 'ClaudeHUD';
const SHORTCUT_NAME = 'Claude HUD';
const PACKAGED = path.join(__dirname, '..', 'build', `${APP_NAME}-win32-x64`);

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const INSTALL_DIR = path.join(LOCAL, 'Programs', APP_NAME);
const START_MENU = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const STARTUP = path.join(START_MENU, 'Startup');

const EXE = path.join(INSTALL_DIR, `${APP_NAME}.exe`);
const START_LNK = path.join(START_MENU, `${SHORTCUT_NAME}.lnk`);
const STARTUP_LNK = path.join(STARTUP, `${SHORTCUT_NAME}.lnk`);

/** Shortcuts are a Windows shell concept; PowerShell is the dependency-free way. */
function makeShortcut(lnk, target, description) {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + quote(lnk) + ')',
    '$s.TargetPath = ' + quote(target),
    '$s.WorkingDirectory = ' + quote(path.dirname(target)),
    '$s.Description = ' + quote(description),
    '$s.IconLocation = ' + quote(target),
    '$s.Save()',
  ].join('; ');

  const r = cp.spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', windowsHide: true });

  if (r.status !== 0) {
    throw new Error(`could not create ${path.basename(lnk)}: ${(r.stderr || '').trim()}`);
  }
}

function quote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
    else fs.copyFileSync(src, dest);
  }
}

function isRunning() {
  const r = cp.spawnSync('tasklist', ['/FI', `IMAGENAME eq ${APP_NAME}.exe`, '/NH'],
    { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').includes(`${APP_NAME}.exe`);
}

function stopRunning() {
  if (!isRunning()) return false;
  // The old copy holds its .exe open, so it has to go before the files move.
  cp.spawnSync('taskkill', ['/IM', `${APP_NAME}.exe`, '/F'], { windowsHide: true });
  return true;
}

function install() {
  if (!fs.existsSync(path.join(PACKAGED, `${APP_NAME}.exe`))) {
    console.error(`Packaged app not found at ${PACKAGED}`);
    console.error('Run:  npm run package');
    process.exit(1);
  }

  if (stopRunning()) console.log('Stopped the running copy.');

  if (fs.existsSync(INSTALL_DIR)) {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    console.log(`Replaced the previous install.`);
  }

  copyTree(PACKAGED, INSTALL_DIR);
  console.log(`Installed to ${INSTALL_DIR}`);

  fs.mkdirSync(START_MENU, { recursive: true });
  makeShortcut(START_LNK, EXE, 'Floating HUD for Claude Code sessions');
  console.log(`Start Menu entry: ${SHORTCUT_NAME}`);

  if (process.argv.includes('--no-startup')) {
    if (fs.existsSync(STARTUP_LNK)) fs.rmSync(STARTUP_LNK);
    console.log('Auto-start: off');
  } else {
    fs.mkdirSync(STARTUP, { recursive: true });
    makeShortcut(STARTUP_LNK, EXE, 'Floating HUD for Claude Code sessions');
    console.log('Auto-start: on (runs at login)');
  }

  // Point Claude Code at the installed hook script rather than this checkout.
  // Shipped outside app.asar precisely so `node` can execute it.
  const installedHook = path.join(INSTALL_DIR, 'resources', 'hooks', 'claude-hook.js');
  if (fs.existsSync(installedHook)) {
    const r = cp.spawnSync(process.execPath,
      [path.join(__dirname, 'install-hooks.js'), '--script', installedHook],
      { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) {
      console.error('Hook install failed:', (r.stderr || '').trim());
      console.error('The app still works, but permission alerts will be off.');
    }
  } else {
    console.error(`Warning: hook script missing from the package (${installedHook})`);
  }

  console.log('');
  console.log('Done. Launch it from the Start Menu, or:');
  console.log(`  ${EXE}`);
}

function remove() {
  if (stopRunning()) console.log('Stopped the running copy.');
  for (const lnk of [START_LNK, STARTUP_LNK]) {
    if (fs.existsSync(lnk)) {
      fs.rmSync(lnk);
      console.log(`Removed ${path.basename(lnk)}`);
    }
  }
  if (fs.existsSync(INSTALL_DIR)) {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    console.log(`Removed ${INSTALL_DIR}`);
  }
  console.log('');
  console.log('Claude Code hooks were left in place. To remove those too:');
  console.log('  npm run uninstall-hooks');
}

function main() {
  if (process.platform !== 'win32') {
    console.error('This installer is Windows-only.');
    process.exit(1);
  }
  if (process.argv.includes('--remove')) remove();
  else install();
}

main();
