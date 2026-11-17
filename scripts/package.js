#!/usr/bin/env node
'use strict';
/**
 * Packages the HUD into a standalone Windows app in build/.
 *
 *   node scripts/package.js
 *
 * The Electron binary is reused from a local zip cache rather than downloaded,
 * because fetching it from GitHub has proved unreliable here. Point
 * ELECTRON_ZIP_DIR at a directory holding electron-v<version>-win32-x64.zip to
 * override where that cache lives.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// v18+ exports a named `packager`; older versions were the function itself.
const packagerModule = require('@electron/packager');
const packager = typeof packagerModule === 'function'
  ? packagerModule
  : packagerModule.packager;

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'ClaudeHUD';

const VERSION = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const ZIP_NAME = `electron-v${VERSION}-win32-x64.zip`;

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ZIP_DIR = process.env.ELECTRON_ZIP_DIR || path.join(LOCAL, 'electron-zips');

/**
 * Packager wants a zip, but a previous run may only have left the extracted
 * dist. Seed the cache from any zip we can find before giving up.
 */
function ensureZip() {
  const target = path.join(ZIP_DIR, ZIP_NAME);
  if (fs.existsSync(target)) return target;

  const candidates = [
    process.env.ELECTRON_ZIP,
    path.join(ROOT, ZIP_NAME),
    path.join(ROOT, 'electron.zip'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      fs.mkdirSync(ZIP_DIR, { recursive: true });
      fs.copyFileSync(c, target);
      console.log(`cached ${path.basename(c)} -> ${target}`);
      return target;
    }
  }
  return null;
}

async function main() {
  const zip = ensureZip();
  if (!zip) {
    console.error(`Missing ${ZIP_NAME}.`);
    console.error(`Put it in ${ZIP_DIR} (or set ELECTRON_ZIP to its path), e.g.:`);
    console.error('');
    console.error(`  curl -L --retry 20 --retry-all-errors --continue-at - \\`);
    console.error(`    -o "${ZIP_NAME}" \\`);
    console.error(`    "https://github.com/electron/electron/releases/download/v${VERSION}/${ZIP_NAME}"`);
    process.exit(1);
  }
  console.log(`using ${zip}`);

  const paths = await packager({
    dir: ROOT,
    name: APP_NAME,
    platform: 'win32',
    arch: 'x64',
    out: path.join(ROOT, 'build'),
    overwrite: true,
    prune: true, // drops devDependencies, i.e. electron and the packager itself
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    electronZipDir: ZIP_DIR,
    // Claude Code runs the hook with `node <path>`, and an external process
    // cannot read inside an asar archive. Shipping hooks/ as a plain resource
    // keeps it executable; without this, permission alerts die silently.
    extraResource: [path.join(ROOT, 'hooks')],
    // Build outputs and local caches must not end up inside the app.
    ignore: [
      /^\/build($|\/)/,
      /^\/dist($|\/)/,
      /^\/\.git($|\/)/,
      /^\/electron.*\.zip$/,
    ],
    win32metadata: {
      CompanyName: 'Claude HUD',
      FileDescription: 'Floating HUD for Claude Code sessions',
      ProductName: 'Claude HUD',
      InternalName: APP_NAME,
    },
    appVersion: require(path.join(ROOT, 'package.json')).version,
  });

  for (const p of paths) {
    console.log(`\npackaged: ${p}`);
    const exe = path.join(p, `${APP_NAME}.exe`);
    console.log(`  exe: ${exe}  ${fs.existsSync(exe) ? '(ok)' : '(MISSING)'}`);
    // Must sit outside the asar so `node` can run it.
    const hook = path.join(p, 'resources', 'hooks', 'claude-hook.js');
    console.log(`  hook (runnable): ${fs.existsSync(hook) ? 'ok' : 'MISSING'}`);
    const asar = path.join(p, 'resources', 'app.asar');
    console.log(`  app bundle: ${fs.existsSync(asar) ? 'app.asar' : 'MISSING'}`);
  }

  console.log('\nNext:  npm run install-app');
}

main().catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
