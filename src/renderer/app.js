'use strict';
/**
 * Renderer: paints the HUD from the payload the main process pushes, and keeps
 * the window height matched to the content.
 */

const el = {
  card: document.getElementById('card'),
  bar: document.getElementById('bar'),
  headline: document.getElementById('headline'),
  subline: document.getElementById('subline'),
  gauge: document.getElementById('gauge'),
  gaugeArc: document.getElementById('gauge-arc'),
  gaugeLabel: document.getElementById('gauge-label'),
  toggle: document.getElementById('toggle'),
  close: document.getElementById('close'),
  alerts: document.getElementById('alerts'),
  sessions: document.getElementById('sessions'),
  usageValue: document.getElementById('usage-value'),
  spark: document.getElementById('spark'),
  footer: document.getElementById('footer'),
};

// 2 * pi * r, with r = 15.5 as set on the gauge circles.
const ARC_LENGTH = 97.39;
const COLLAPSED_HEIGHT = 52;

let collapsed = false;
let lastPayload = null;

// ---- formatting -----------------------------------------------------------

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function modelShort(model) {
  if (!model) return null;
  const m = /(opus|sonnet|haiku|fable)/i.exec(model);
  return m ? m[1].toLowerCase() : model;
}

const STATE_LABEL = {
  working: 'working',
  ready: 'your turn',
  permission: 'needs you',
  idle: 'waiting',
};

function level(pct) {
  if (pct >= 0.9) return 'hot';
  if (pct >= 0.7) return 'warn';
  return '';
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function add(parent, tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  parent.append(n);
  return n;
}

// ---- rendering ------------------------------------------------------------

/** One body-level state class drives the card wash and status light. */
function renderStatus(p) {
  const working = p.sessions.filter(s => s.state === 'working').length;
  const alert = p.attention.length > 0;

  document.body.classList.toggle('state-attention', alert);
  document.body.classList.toggle('state-working', !alert && working > 0);
  document.body.classList.toggle('state-ready', !alert && working === 0 && p.sessions.length > 0);
  el.card.classList.toggle('attention', alert);

  const n = p.sessions.length;
  if (n === 0) {
    el.headline.textContent = 'No sessions';
    el.subline.textContent = 'nothing running';
    el.subline.classList.remove('alarm');
    return;
  }

  if (alert) {
    const first = p.attention[0];
    el.headline.textContent = p.attention.length > 1
      ? `${p.attention.length} sessions need you`
      : `${first.label} needs you`;
    el.subline.textContent = 'permission required';
    el.subline.classList.add('alarm');
    return;
  }

  el.subline.classList.remove('alarm');
  el.headline.textContent = working > 0
    ? `${working} working`
    : `${n} session${n === 1 ? '' : 's'}`;

  // Name the busiest session so the collapsed pill still says something useful.
  const busiest = p.sessions.slice().sort((a, b) => b.contextPct - a.contextPct)[0];
  el.subline.textContent = busiest
    ? `${busiest.label} · ${Math.round(busiest.contextPct * 100)}% context`
    : '';
}

function renderGauge(p) {
  const { totalTokens, budget } = p.usage;
  const pct = budget ? Math.min(1, totalTokens / budget) : 0;
  el.gaugeArc.style.strokeDashoffset = String(ARC_LENGTH * (1 - pct));
  el.gaugeArc.className.baseVal = `gauge-arc ${level(pct)}`.trim();
  el.gaugeLabel.textContent = `${Math.round(pct * 100)}`;
  el.gauge.title = `${totalTokens.toLocaleString()} tokens in the last 5h`
    + ` (${Math.round(pct * 100)}% of a ${tokens(budget)} budget)`;
}

function renderAlerts(p) {
  clear(el.alerts);
  for (const s of p.attention) {
    const div = add(el.alerts, 'div', 'alert');
    add(div, 'span', 'alert-icon', '!');
    const text = add(div, 'div', 'alert-text');
    add(text, 'div', 'alert-title', `${s.label} needs permission`);
    add(text, 'div', 'alert-sub', s.stateMessage || s.cwd || '');
    add(div, 'span', 'alert-go', '→');
    div.title = 'Jump to this session in VS Code';
    div.addEventListener('click', () => window.hud.open(s.cwd));
  }
}

function renderSessions(p) {
  clear(el.sessions);

  if (p.sessions.length === 0) {
    add(el.sessions, 'div', 'empty', 'No Claude Code sessions open.');
    return;
  }

  for (const s of p.sessions) {
    const row = add(el.sessions, 'div', `row ${s.state}`);
    row.title = `${s.cwd || ''}\n${s.model || 'starting up'} · ${s.turns} turns`
      + ` · ${tokens(s.billedTokens)} tokens billed · pid ${s.pid}`
      + `\nClick to open in VS Code`;
    row.addEventListener('click', () => window.hud.open(s.cwd));

    const top = add(row, 'div', 'row-top');
    add(top, 'span', 'row-name', s.label);

    const model = modelShort(s.model);
    if (model) add(top, 'span', 'chip', model);
    if (s.branch) add(top, 'span', 'chip branch', s.branch);

    const state = add(top, 'span', `row-state ${s.state}`);
    if (s.state === 'working') {
      add(state, 'span', null, STATE_LABEL.working);
      const dots = add(state, 'span', 'dots');
      add(dots, 'i'); add(dots, 'i'); add(dots, 'i');
    } else {
      state.textContent = `${STATE_LABEL[s.state] || s.state} · ${ago(p.now - s.stateTs)}`;
    }

    const barRow = add(row, 'div', 'row-bar');
    const track = add(barRow, 'div', 'track');
    const fill = add(track, 'div', `fill ${level(s.contextPct)}`.trim());
    fill.style.width = `${(s.contextPct * 100).toFixed(1)}%`;

    // At the ceiling Claude Code compacts, which matters more than the number.
    // A "~" marks a window size inferred from what the session has held.
    const hot = s.contextPct >= 0.9;
    const ceiling = `${s.limitInferred ? '~' : ''}${tokens(s.contextLimit)}`;
    add(barRow, 'span', `row-pct ${hot ? 'hot' : ''}`.trim(),
      s.contextPct >= 0.99 ? 'context full' : `${tokens(s.contextTokens)} / ${ceiling}`);
  }
}

function renderUsage(p) {
  const { totalTokens, budget, buckets } = p.usage;
  el.usageValue.textContent = `${tokens(totalTokens)} / ${tokens(budget)}`;
  el.usageValue.title =
    `${totalTokens.toLocaleString()} tokens billed at full rate in the last 5 hours`
    + ' (cache reads excluded)';

  clear(el.spark);
  const list = buckets && buckets.length ? buckets : new Array(24).fill(0);
  const peak = Math.max(...list, 1);
  list.forEach((v, i) => {
    const bar = add(el.spark, 'i', i === list.length - 1 ? 'now' : (v === 0 ? 'zero' : ''));
    // Square-root scaling keeps small-but-real buckets visible next to a spike.
    const h = v === 0 ? 2 : Math.max(2, Math.round(Math.sqrt(v / peak) * 22));
    bar.style.height = `${h}px`;
  });
}

function renderFooter(p) {
  if (p.hooksInstalled) {
    el.footer.classList.add('hidden');
    el.footer.textContent = '';
    return;
  }
  el.footer.classList.remove('hidden');
  el.footer.textContent = 'Permission alerts are off — run: npm run install-hooks';
}

function render(p) {
  lastPayload = p;
  renderStatus(p);
  renderGauge(p);
  if (!collapsed) {
    renderAlerts(p);
    renderSessions(p);
    renderUsage(p);
    renderFooter(p);
  }
  syncHeight();
}

// ---- window sizing -------------------------------------------------------

function syncHeight() {
  // Measured after layout so the window hugs the content exactly.
  requestAnimationFrame(() => {
    const h = collapsed
      ? COLLAPSED_HEIGHT
      : Math.ceil(el.card.getBoundingClientRect().height);
    window.hud.setHeight(h);
  });
}

function setCollapsed(v) {
  collapsed = v;
  document.body.classList.toggle('collapsed', collapsed);
  window.hud.setCollapsed(collapsed);
  if (lastPayload) render(lastPayload);
  else syncHeight();
}

// ---- wiring --------------------------------------------------------------

el.toggle.addEventListener('click', () => setCollapsed(!collapsed));
el.close.addEventListener('click', () => window.hud.hide());

// Double-clicking the bar is a quick collapse, like a window title bar.
el.bar.addEventListener('dblclick', (e) => {
  if (e.target.closest('.icon-btn')) return;
  setCollapsed(!collapsed);
});

window.hud.onState((payload) => {
  if (lastPayload === null && payload.collapsed !== undefined) {
    collapsed = !!payload.collapsed;
    document.body.classList.toggle('collapsed', collapsed);
  }
  render(payload);
});

// The main process pushes on every watcher tick, which is what keeps the
// relative times fresh -- no separate repaint timer is needed here.

window.hud.ready();
