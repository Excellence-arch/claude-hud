'use strict';
/**
 * Electron main process for the Claude Code HUD.
 *
 * Owns the floating window and merges the three data sources (session registry,
 * transcript watcher, hook event bridge) into a single payload for the renderer.
 */
const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { SessionWatcher } = require('./watcher');
const { EventBridge } = require('./events');
const { SessionRegistry } = require('./sessions');
const { mergeSessions } = require('./merge');
const { UI_STATE_FILE, ensureStateDir } = require('./paths');
const { DEFAULT_WINDOW_BUDGET } = require('./config');

const WIDTH = 348;
const COLLAPSED_HEIGHT = 52;
const EDGE_MARGIN = 24;


let win = null;
let tray = null;
let watcher = null;
let bridge = null;
let registry = null;
let latestSnapshot = { now: Date.now(), sessions: [], window: { totalTokens: 0 } };
let hookStates = {};
let uiState = null;
let alerting = new Set();
let saveTimer = null;
let lastHeight = null;
let trayIsAlert = null;
const trayCache = new Map();

// ---- persisted UI state ---------------------------------------------------

function loadUiState() {
  const defaults = {
    x: null, y: null,
    collapsed: false,
    windowBudget: DEFAULT_WINDOW_BUDGET,
    alertSound: true,
    // 'editor' focuses VS Code on the project; 'folder' reveals it in Explorer.
    openWith: 'editor',
  };
  try {
    return Object.assign(defaults, JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf8')));
  } catch {
    return defaults;
  }
}

function saveUiState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      ensureStateDir();
      fs.writeFileSync(UI_STATE_FILE, JSON.stringify(uiState, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }, 400);
  if (saveTimer.unref) saveTimer.unref();
}

// ---- payload --------------------------------------------------------------

function mergePayload() {
  const live = registry ? registry.list() : [];
  const { now, sessions, attention } = mergeSessions(live, latestSnapshot, hookStates);
  return {
    now,
    sessions,
    attention,
    usage: {
      totalTokens: latestSnapshot.window.totalTokens,
      budget: uiState.windowBudget,
      windowMs: latestSnapshot.window.windowMs,
      since: latestSnapshot.window.since,
      buckets: latestSnapshot.window.buckets || [],
    },
    hooksInstalled: bridge ? bridge.isInstalled() : false,
    collapsed: uiState.collapsed,
  };
}

function push() {
  if (!win || win.isDestroyed()) return;
  const payload = mergePayload();
  win.webContents.send('hud:state', payload);
  updateTray(payload);
  applyAlert(payload);
}

// ---- attention handling ---------------------------------------------------

function applyAlert(payload) {
  const ids = new Set(payload.attention.map(s => s.sessionId));
  // Alert per newly-blocked session, not just on the first one: a second
  // session needing approval while another is pending must still get noticed.
  let fresh = false;
  for (const id of ids) if (!alerting.has(id)) { fresh = true; break; }
  const cleared = alerting.size > 0 && ids.size === 0;
  alerting = ids;
  if (!fresh && !cleared) return;

  if (!win || win.isDestroyed()) return;
  if (fresh) {
    // Surface the window without stealing keyboard focus from the editor.
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.flashFrame(true);
    if (uiState.alertSound) shell.beep();
  } else {
    win.flashFrame(false);
  }
}

function updateTray(payload) {
  if (!tray) return;
  const alert = payload.attention.length > 0;
  // Only swap the icon when the state actually flips; this runs every tick and
  // trayImage() reads from disk.
  if (alert !== trayIsAlert) {
    trayIsAlert = alert;
    tray.setImage(trayImage(alert));
  }
  const n = payload.sessions.length;
  const parts = [`${n} session${n === 1 ? '' : 's'}`];
  if (alert) parts.push(`${payload.attention.length} awaiting you`);
  tray.setToolTip(`Claude HUD - ${parts.join(' - ')}`);
}

function trayImage(alert) {
  if (trayCache.has(alert)) return trayCache.get(alert);
  const file = path.join(__dirname, '..', '..', 'assets', alert ? 'tray-alert.png' : 'tray.png');
  const img = nativeImage.createFromPath(file);
  const scaled = img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
  trayCache.set(alert, scaled);
  return scaled;
}

// ---- opening a project ----------------------------------------------------

/**
 * Brings up the editor for a project, which is where a permission prompt is
 * actually answered -- a file-explorer window is no use for that.
 *
 * `code -r <folder>` reuses and focuses an existing window already open on that
 * folder, so clicking an alert jumps straight to the session that is waiting.
 * The CLI is a .cmd shim on Windows and therefore needs a shell; if it is not
 * on PATH at all, fall back to revealing the folder.
 */
function openProject(dir) {
  if (uiState.openWith === 'folder') {
    shell.openPath(dir);
    return;
  }
  try {
    const child = cp.spawn(`code -r "${dir}"`, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => shell.openPath(dir));
    child.on('exit', (code) => {
      // A non-zero exit means the shim was found but failed, or was missing.
      if (code !== 0) shell.openPath(dir);
    });
    child.unref();
  } catch {
    shell.openPath(dir);
  }
}

// ---- window ---------------------------------------------------------------

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - WIDTH - EDGE_MARGIN,
    y: area.y + EDGE_MARGIN,
  };
}

/** Keep the window on a display that actually exists (monitors get unplugged). */
function clampToDisplay(x, y) {
  const nearest = screen.getDisplayNearestPoint({ x, y }).workArea;
  const maxX = nearest.x + nearest.width - 80;
  const maxY = nearest.y + nearest.height - 40;
  return {
    x: Math.min(Math.max(x, nearest.x - WIDTH + 80), maxX),
    y: Math.min(Math.max(y, nearest.y), maxY),
  };
}

function createWindow() {
  const pos = (uiState.x === null || uiState.y === null)
    ? defaultPosition()
    : clampToDisplay(uiState.x, uiState.y);

  win = new BrowserWindow({
    width: WIDTH,
    height: COLLAPSED_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' is the highest level, so the HUD stays visible over
  // full-screen windows too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => win.showInactive());

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    uiState.x = x;
    uiState.y = y;
    saveUiState();
  });

  // Keep external links out of the HUD frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  try {
    tray = new Tray(trayImage(false));
  } catch {
    return; // tray is a convenience, not a requirement
  }
  const menu = Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggleWindow },
    { label: 'Reset position', click: () => {
      const p = defaultPosition();
      uiState.x = p.x; uiState.y = p.y;
      saveUiState();
      if (win) win.setPosition(p.x, p.y);
    } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('Claude HUD');
  tray.on('click', toggleWindow);
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
}

// ---- ipc ------------------------------------------------------------------

function registerIpc() {
  ipcMain.on('hud:ready', () => push());

  // The renderer measures its own content and asks for a matching window.
  ipcMain.on('hud:height', (_e, height) => {
    if (!win || win.isDestroyed()) return;
    const h = Math.max(COLLAPSED_HEIGHT, Math.min(900, Math.round(height)));
    // The renderer re-measures on every tick; resizing only on an actual change
    // avoids pointless window churn while hovering or dragging.
    if (h === lastHeight) return;
    lastHeight = h;
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: WIDTH, height: h });
  });

  ipcMain.on('hud:collapsed', (_e, collapsed) => {
    uiState.collapsed = !!collapsed;
    saveUiState();
  });

  ipcMain.on('hud:open', (_e, target) => {
    if (typeof target === 'string' && target) openProject(target);
  });

  ipcMain.on('hud:hide', () => { if (win) win.hide(); });

  ipcMain.on('hud:quit', () => { app.isQuitting = true; app.quit(); });

  ipcMain.handle('hud:budget', (_e, value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      uiState.windowBudget = Math.round(n);
      saveUiState();
    }
    return uiState.windowBudget;
  });
}

// ---- boot -----------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); }
  });

  // The HUD is a background utility; it should not own a dock/taskbar slot.
  if (app.dock) app.dock.hide();

  app.whenReady().then(() => {
    uiState = loadUiState();
    registerIpc();
    createWindow();
    createTray();

    registry = new SessionRegistry();

    bridge = new EventBridge();
    bridge.on('change', states => { hookStates = states; push(); });
    bridge.start();

    watcher = new SessionWatcher();
    watcher.on('update', snap => { latestSnapshot = snap; push(); });
    // The first scan reads transcript tails and can take a second or two, so it
    // runs after the window has painted.
    setTimeout(() => watcher.start(), 150);
  });

  app.on('window-all-closed', () => { /* stay resident in the tray */ });

  app.on('before-quit', () => {
    if (watcher) watcher.stop();
    if (bridge) bridge.stop();
  });
}
