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

// Sessions whose drill-down is open. Kept here rather than in the DOM, because
// the session list is rebuilt from scratch on every push.
const expanded = new Set();

// So is scroll position: the watcher pushes every couple of seconds, and a
// rebuilt list would otherwise jump back to the top under the reader.
let listScroll = 0;
const stepScroll = new Map(); // sessionId -> scrollTop of its timeline

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

/** What each timeline entry is, in a word, for the chip at its left. */
const KIND_LABEL = {
  prompt: 'you',
  say: 'reply',
  agent: 'agent',
  brief: 'brief',
  tool: null, // the tool names itself
};

/** Verb for the live step, so the "now" line reads as a sentence. */
function stepPhrase(step) {
  if (!step) return null;
  if (step.kind === 'tool') {
    return step.text ? `${step.tool} · ${step.text}` : step.tool;
  }
  if (step.kind === 'agent') return `delegated · ${step.text}`;
  if (step.kind === 'prompt') return `your prompt · ${step.text}`;
  if (step.kind === 'brief') return step.text;
  return step.text;
}

function level(pct) {
  if (pct >= 0.9) return 'hot';
  if (pct >= 0.7) return 'warn';
  return '';
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A chevron, matching the one on the title bar. CSS rotates it when closed. */
function chevron(parent) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 6');
  svg.setAttribute('width', '9');
  svg.setAttribute('height', '6');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M1 1l4 4 4-4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  parent.append(svg);
  return svg;
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

  // A session that has closed must not keep its drill-down open forever.
  const live = new Set(p.sessions.map(s => s.sessionId));
  for (const id of expanded) if (!live.has(id)) expanded.delete(id);
  for (const id of stepScroll.keys()) if (!live.has(id)) stepScroll.delete(id);

  const toggle = (id) => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    if (lastPayload) render(lastPayload);
  };

  for (const s of p.sessions) {
    const open = expanded.has(s.sessionId);
    const row = add(el.sessions, 'div', `row ${s.state}${open ? ' open' : ''}`);
    row.title = `${s.cwd || ''}\n${s.model || 'starting up'} · ${s.turns} turns`
      + ` · ${tokens(s.billedTokens)} tokens billed · pid ${s.pid}`
      + `\nClick for the agent map and activity`;

    const top = add(row, 'div', 'row-top');

    // An explicit button, so it is obvious a row has more behind it. The whole
    // row stays clickable too, since that is the bigger target.
    const caret = add(top, 'button', 'row-toggle no-drag');
    chevron(caret);
    caret.title = open ? 'Hide the agent map' : 'Show the agent map and activity';
    caret.setAttribute('aria-expanded', open ? 'true' : 'false');
    caret.setAttribute('aria-label', caret.title);
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle(s.sessionId);
    });

    add(top, 'span', 'row-name', s.label);

    const model = modelShort(s.model);
    if (model) add(top, 'span', 'chip', model);
    if (s.branch) add(top, 'span', 'chip branch', s.branch);

    const running = s.activity ? s.activity.runningAgents : 0;
    if (running > 0) {
      const chip = add(top, 'span', 'chip agents', `${running} agent${running === 1 ? '' : 's'}`);
      chip.title = `${running} subagent${running === 1 ? '' : 's'} running`;
    }

    const state = add(top, 'span', `row-state ${s.state}`);
    if (s.state === 'working') {
      add(state, 'span', null, STATE_LABEL.working);
      const dots = add(state, 'span', 'dots');
      add(dots, 'i'); add(dots, 'i'); add(dots, 'i');
    } else {
      state.textContent = `${STATE_LABEL[s.state] || s.state} · ${ago(p.now - s.stateTs)}`;
    }

    // Opening the editor moved onto its own button once the row itself became
    // the control for the drill-down.
    const go = add(top, 'button', 'row-open no-drag', '↗');
    go.title = 'Open this project in VS Code';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      window.hud.open(s.cwd);
    });

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

    renderNow(row, s, open);
    if (open) renderDetail(row, s, p.now);

    row.addEventListener('click', () => toggle(s.sessionId));
  }

  // The list was rebuilt from nothing, so put the reader back where they were.
  el.sessions.scrollTop = listScroll;
}

/**
 * The live step, on the row itself. It is what makes the closed row answer
 * "doing what?" without a click. Once the row is open the agent map says the
 * same thing in more detail, so this line stands down.
 */
function renderNow(row, s, open) {
  const step = s.activity && s.activity.current;
  if (!step || open) return;
  if (s.state !== 'working') return;

  const line = add(row, 'div', 'row-now');
  const live = step.status === 'running';
  add(line, 'span', `now-dot ${live ? 'live' : (step.status || '')}`.trim());
  add(line, 'span', 'now-text', stepPhrase(step) || '');
}

/** The drop-down: who is working on what, and the steps taken so far. */
function renderDetail(row, s, now) {
  const detail = add(row, 'div', 'detail no-drag');
  // Clicks inside the panel must not collapse the row out from under them.
  detail.addEventListener('click', e => e.stopPropagation());

  const agents = (s.activity && s.activity.agents) || [];
  const events = (s.activity && s.activity.events) || [];

  add(detail, 'div', 'detail-head', 'Agents');
  const map = add(detail, 'div', 'agent-map');
  if (agents.length === 0) {
    add(map, 'div', 'detail-empty', 'No activity read from the transcript yet.');
  }
  for (const a of agents) {
    const item = add(map, 'div', `agent ${a.state}`);

    const head = add(item, 'div', 'agent-head');
    add(head, 'span', `agent-dot ${a.state}`);
    add(head, 'span', 'agent-name', a.kind === 'main' ? 'main thread' : a.label);
    if (a.kind !== 'main' && a.type) add(head, 'span', 'chip agent-type', a.type);

    const meta = add(head, 'span', 'agent-meta');
    const bits = [];
    if (a.turns) bits.push(`${a.turns} turn${a.turns === 1 ? '' : 's'}`);
    if (a.tokens) bits.push(tokens(a.tokens));
    if (a.state === 'running' && a.lastTs) bits.push(ago(now - a.lastTs));
    else if (a.endTs) bits.push(`done ${ago(now - a.endTs)} ago`);
    meta.textContent = bits.join(' · ');

    const doing = add(item, 'div', 'agent-doing');
    if (a.state === 'running') {
      doing.textContent = a.current ? stepPhrase(a.current) : 'waiting for its next step';
    } else {
      doing.textContent = a.state === 'error' ? 'finished with an error' : 'finished';
      doing.classList.add('muted');
    }
  }

  add(detail, 'div', 'detail-head', 'Activity');
  const list = add(detail, 'div', 'steps');
  list.addEventListener('scroll', () => stepScroll.set(s.sessionId, list.scrollTop));
  if (events.length === 0) {
    add(list, 'div', 'detail-empty', 'Nothing recorded yet.');
  }

  // Subagent steps are tagged, so a mixed timeline stays readable.
  const byId = new Map(agents.map(a => [a.id, a]));

  for (const e of events) {
    const item = add(list, 'div', `step ${e.kind}`);
    add(item, 'span', `step-dot ${e.status === 'running' ? 'live' : (e.status || e.kind)}`);

    const label = e.kind === 'tool' ? e.tool : (KIND_LABEL[e.kind] || e.kind);
    add(item, 'span', `step-tag ${e.kind}`, label);
    add(item, 'span', 'step-text', e.text || '');

    const owner = byId.get(e.agentId);
    if (owner && owner.kind === 'subagent') {
      add(item, 'span', 'step-agent', owner.type || 'agent');
    }

    add(item, 'span', 'step-time mono', ago(now - e.ts));
  }

  // Same reason as the session list: this panel is rebuilt on every push, and
  // scrolling back through a history must survive that.
  const kept = stepScroll.get(s.sessionId);
  if (kept) list.scrollTop = kept;
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

/**
 * The window grows to fit its content, so without a ceiling an expanded row on
 * a short screen would push the card off the display. The main process says how
 * tall the window may get; the session list absorbs the difference by scrolling.
 */
function applyHeightCap(p) {
  const cap = Number(p.maxHeight);
  if (!Number.isFinite(cap) || cap <= 0) return;
  // Header, alerts, the usage block and padding live outside the list.
  const chrome = 150 + el.alerts.getBoundingClientRect().height;
  el.sessions.style.maxHeight = `${Math.max(140, Math.round(cap - chrome))}px`;
}

function render(p) {
  lastPayload = p;
  renderStatus(p);
  renderGauge(p);
  if (!collapsed) {
    renderAlerts(p);
    renderSessions(p);
    applyHeightCap(p);
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

// Remembered so the next push can restore it; the list is rebuilt each time.
el.sessions.addEventListener('scroll', () => { listScroll = el.sessions.scrollTop; });

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
