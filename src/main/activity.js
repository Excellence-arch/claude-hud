'use strict';
/**
 * Turns raw transcript entries into a readable account of what a session is
 * doing and what it has already done.
 *
 * The rest of the HUD answers "is this session busy, and how full is its
 * context". This module answers the next question down: *doing what?* It keeps,
 * per session:
 *
 *   - a bounded timeline of steps (prompts, tool calls and their outcome,
 *     replies), oldest first;
 *   - an agent map: the main thread plus every subagent the session has
 *     launched via the Task tool, each with its own live step.
 *
 * Everything is derived from entries the watcher already parses, so this adds
 * no extra file reads.
 */
const path = require('path');

/** Per-session timeline cap. Enough to scroll back through a turn or two. */
const MAX_EVENTS = 60;
/** Per-session subagent cap; oldest finished ones are dropped first. */
const MAX_AGENTS = 16;
/** Guards the uuid -> agent map against unbounded growth on long sessions. */
const MAX_LINKS = 400;
/** Transcript uuids remembered for de-duplication. */
const MAX_SEEN = 400;

const MAIN = 'main';

function shorten(text, max = 90) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function base(p) {
  if (typeof p !== 'string' || !p) return '';
  return path.basename(p.replace(/[\\/]+$/, ''));
}

/**
 * A one-line description of a tool call, in the terms the user thinks in
 * ("Read config.js", not a JSON blob). Falls back to the first short string in
 * the input, so an unknown or MCP tool still says something.
 */
function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return shorten(i.description || i.command, 70);
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return base(i.file_path || i.notebook_path);
    case 'Edit':
      return base(i.file_path);
    case 'Glob':
      return shorten(i.pattern, 50);
    case 'Grep':
      return shorten(i.path ? `${i.pattern} in ${base(i.path)}` : i.pattern, 60);
    case 'Task':
      return shorten(i.description || i.subagent_type, 70);
    case 'WebFetch':
      try { return new URL(i.url).hostname; } catch { return shorten(i.url, 50); }
    case 'WebSearch':
      return shorten(i.query, 60);
    case 'TodoWrite':
      return 'updating the plan';
    case 'Skill':
      return shorten(i.skill, 50);
    default: {
      for (const key of ['description', 'query', 'prompt', 'command', 'pattern', 'file_path', 'url']) {
        if (typeof i[key] === 'string' && i[key]) return shorten(i[key], 60);
      }
      return '';
    }
  }
}

/** MCP tool ids are long; show the server and the tool, not the whole path. */
function displayName(name) {
  if (typeof name !== 'string') return 'tool';
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  return parts.length >= 3 ? `${parts[1]}·${parts[parts.length - 1]}` : name;
}

function trimMap(map, max) {
  if (map.size <= max) return;
  let drop = map.size - max;
  for (const key of map.keys()) {
    map.delete(key);
    if (--drop <= 0) break;
  }
}

class SessionActivity {
  constructor() {
    this.events = [];            // oldest first; the view reverses it
    this.agents = new Map();     // agentId -> agent record
    this.pending = new Map();    // tool_use_id -> event awaiting its result
    this.links = new Map();      // transcript uuid -> agentId, for sidechains
    this.seen = new Set();       // entry uuids already folded in
    this.seq = 0;
    this.agents.set(MAIN, {
      id: MAIN, kind: MAIN, type: null, label: 'main thread',
      state: 'running', startTs: 0, endTs: null,
      tokens: 0, turns: 0, steps: 0, lastTs: 0, current: null,
    });
  }

  agent(id) {
    return this.agents.get(id) || this.agents.get(MAIN);
  }

  /**
   * Which agent an entry belongs to. Subagent entries carry no agent id, so
   * they are chained by parentUuid back to the sidechain's opening prompt,
   * which is matched to the Task call that launched it.
   */
  agentIdFor(entry) {
    if (!entry.isSidechain) return MAIN;
    const link = entry.parentUuid && this.links.get(entry.parentUuid);
    if (link) return link;
    return this.adoptSidechain(entry);
  }

  /**
   * A sidechain root (no parent) is the subagent's opening prompt, and its text
   * is the prompt the Task call supplied. Match on that; if several agents are
   * running and none matches, fall back to the most recently launched one,
   * which is nearly always the right answer.
   */
  adoptSidechain(entry) {
    const running = [];
    for (const a of this.agents.values()) {
      if (a.kind === 'subagent' && a.state === 'running') running.push(a);
    }
    if (running.length === 0) return MAIN;

    const text = this.textOf(entry);
    let match = null;
    if (text) {
      const head = text.slice(0, 60);
      match = running.find(a => a.prompt && a.prompt.startsWith(head));
    }
    if (!match) match = running[running.length - 1];
    return match.id;
  }

  textOf(entry) {
    const content = entry.message && entry.message.content;
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const c of content) if (c && c.type === 'text' && c.text) parts.push(c.text);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  push(event) {
    event.seq = ++this.seq;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    const a = this.agent(event.agentId);
    if (a) {
      a.lastTs = Math.max(a.lastTs, event.ts || 0);
      a.steps += 1;
      a.current = event;
    }
    return event;
  }

  /** Billing figures, attributed to whichever agent produced the response. */
  bill(entry, billed) {
    const a = this.agent(this.agentIdFor(entry));
    if (!a) return;
    a.tokens += billed;
    a.turns += 1;
  }

  record(entry, ts) {
    if (entry.type !== 'user' && entry.type !== 'assistant') return;

    if (entry.uuid) {
      if (this.seen.has(entry.uuid)) return;
      this.seen.add(entry.uuid);
      if (this.seen.size > MAX_SEEN) {
        // Sets iterate in insertion order, so this drops the oldest uuids.
        let drop = this.seen.size - MAX_SEEN;
        for (const id of this.seen) { this.seen.delete(id); if (--drop <= 0) break; }
      }
    }

    const agentId = this.agentIdFor(entry);
    if (entry.uuid) {
      this.links.set(entry.uuid, agentId);
      trimMap(this.links, MAX_LINKS);
    }

    if (entry.type === 'user') this.recordUser(entry, ts, agentId);
    else this.recordAssistant(entry, ts, agentId);
  }

  recordUser(entry, ts, agentId) {
    const content = entry.message && entry.message.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];

    for (const c of blocks) {
      if (!c) continue;
      if (c.type === 'tool_result') {
        this.settle(c, ts);
        continue;
      }
      if (c.type !== 'text' || typeof c.text !== 'string' || !c.text.trim()) continue;

      if (entry.isSidechain && agentId !== MAIN) {
        // A subagent's opening prompt is its brief, which the Task row that
        // launched it already shows; later sidechain text is worth a line.
        const a = this.agent(agentId);
        if (a && !a.briefed) { a.briefed = true; continue; }
        this.push({ kind: 'brief', agentId, ts, text: shorten(c.text, 120) });
        continue;
      }
      this.push({ kind: 'prompt', agentId, ts, text: shorten(c.text, 120) });
    }
  }

  /** Close out the tool call a result belongs to, and the agent if it was a Task. */
  settle(block, ts) {
    const ev = this.pending.get(block.tool_use_id);
    if (ev) {
      this.pending.delete(block.tool_use_id);
      ev.status = block.is_error ? 'error' : 'ok';
      ev.endTs = ts;
    }
    const sub = this.agents.get(block.tool_use_id);
    if (sub) {
      sub.state = block.is_error ? 'error' : 'done';
      sub.endTs = ts;
      sub.current = null;
    }
  }

  recordAssistant(entry, ts, agentId) {
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) return;

    for (const c of content) {
      if (!c) continue;

      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        this.push({ kind: 'say', agentId, ts, text: shorten(c.text, 120) });
        continue;
      }

      if (c.type === 'thinking') {
        const a = this.agent(agentId);
        if (a) a.lastTs = Math.max(a.lastTs, ts);
        continue;
      }

      if (c.type !== 'tool_use') continue;

      if (c.name === 'Task') {
        this.startAgent(c, ts, agentId);
        continue;
      }

      const ev = this.push({
        kind: 'tool', agentId, ts,
        tool: displayName(c.name),
        text: describeTool(c.name, c.input),
        status: 'running',
        endTs: null,
      });
      if (c.id) this.pending.set(c.id, ev);
    }
  }

  startAgent(block, ts, parentId) {
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    const id = block.id || `task:${ts}:${this.seq}`;
    this.agents.set(id, {
      id,
      kind: 'subagent',
      type: input.subagent_type || 'agent',
      label: shorten(input.description || input.subagent_type || 'subagent', 60),
      prompt: typeof input.prompt === 'string' ? input.prompt.replace(/\s+/g, ' ').trim() : '',
      parentId,
      state: 'running',
      startTs: ts, endTs: null,
      tokens: 0, turns: 0, steps: 0, lastTs: ts,
      current: null,
      briefed: false,
    });
    this.prune();

    const ev = this.push({
      kind: 'agent', agentId: parentId, ts,
      tool: 'Task',
      text: shorten(input.description || input.subagent_type || 'subagent', 70),
      agentRef: id,
      status: 'running',
      endTs: null,
    });
    if (block.id) this.pending.set(block.id, ev);
  }

  /** Keep the agent map bounded by dropping the oldest *finished* subagents. */
  prune() {
    const subs = [];
    for (const a of this.agents.values()) if (a.kind === 'subagent') subs.push(a);
    if (subs.length <= MAX_AGENTS) return;

    const finished = subs
      .filter(a => a.state !== 'running')
      .sort((x, y) => (x.endTs || 0) - (y.endTs || 0));
    let drop = subs.length - MAX_AGENTS;
    for (const a of finished) {
      if (drop-- <= 0) break;
      this.agents.delete(a.id);
    }
  }

  // ---- output -------------------------------------------------------------

  /**
   * The step the session is on right now. An unfinished tool call is the
   * truest answer; otherwise it is whatever happened last.
   */
  currentStep() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if ((e.kind === 'tool' || e.kind === 'agent') && e.status === 'running') return e;
    }
    return this.events.length ? this.events[this.events.length - 1] : null;
  }

  expose(e) {
    return {
      kind: e.kind,
      agentId: e.agentId,
      ts: e.ts,
      tool: e.tool || null,
      text: e.text || '',
      status: e.status || null,
      endTs: e.endTs || null,
      agentRef: e.agentRef || null,
    };
  }

  view(limit = 24) {
    const events = this.events.slice(-limit).reverse().map(e => this.expose(e));

    const agents = [];
    for (const a of this.agents.values()) {
      if (a.kind !== MAIN && a.steps === 0 && a.state !== 'running') continue;
      agents.push({
        id: a.id,
        kind: a.kind,
        type: a.type,
        label: a.label,
        state: a.state,
        startTs: a.startTs,
        endTs: a.endTs,
        tokens: a.tokens,
        turns: a.turns,
        steps: a.steps,
        lastTs: a.lastTs,
        current: a.current ? this.expose(a.current) : null,
      });
    }
    // Main thread first, then subagents newest-launched first.
    agents.sort((x, y) => {
      if (x.kind !== y.kind) return x.kind === MAIN ? -1 : 1;
      return (y.startTs || 0) - (x.startTs || 0);
    });

    const cur = this.currentStep();
    let running = 0;
    for (const a of agents) if (a.kind === 'subagent' && a.state === 'running') running++;

    return {
      events,
      agents,
      current: cur ? this.expose(cur) : null,
      runningAgents: running,
    };
  }
}

module.exports = {
  SessionActivity, describeTool, displayName, shorten,
  MAX_EVENTS, MAX_AGENTS,
};
