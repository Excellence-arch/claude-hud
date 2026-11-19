#!/usr/bin/env node
'use strict';
/**
 * Self-test for the transcript parsing rules that are easy to get wrong:
 * incremental resume, requestId deduplication, and subagent isolation.
 *
 *   node scripts/selftest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionWatcher } = require('../src/main/watcher');
const { mergeSessions } = require('../src/main/merge');
const { EventBridge, STATES } = require('../src/main/events');
const { SessionActivity, MAX_EVENTS } = require('../src/main/activity');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${actual}, expected ${expected})`}`);
}

function entry(opts) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: opts.sessionId || 's1',
    requestId: opts.requestId,
    timestamp: new Date(opts.ts || Date.now()).toISOString(),
    cwd: opts.cwd || path.join('c:', 'work', 'demo'),
    gitBranch: opts.branch || 'main',
    isSidechain: !!opts.sidechain,
    message: {
      model: opts.model || 'claude-opus-5',
      content: [{ type: opts.block || 'text' }],
      usage: {
        input_tokens: opts.input || 0,
        cache_read_input_tokens: opts.cacheRead || 0,
        cache_creation_input_tokens: opts.cacheWrite || 0,
        output_tokens: opts.output || 0,
      },
    },
  }) + '\n';
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-selftest-'));
  const projectDir = path.join(root, 'c--work-demo');
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, 'session.jsonl');

  // One response split across three lines, all repeating the same usage.
  const split = { requestId: 'req_A', input: 10, cacheRead: 1000, cacheWrite: 100, output: 50 };
  fs.writeFileSync(file,
    entry(Object.assign({ block: 'thinking' }, split)) +
    entry(Object.assign({ block: 'text' }, split)) +
    entry(Object.assign({ block: 'tool_use' }, split)));

  const w = new SessionWatcher({ projectsDir: root });
  w.scan();
  let snap = w.snapshot();

  check('one split response counts as one turn', snap.sessions[0].turns, 1);
  check('billed tokens not multiplied', snap.sessions[0].billedTokens, 10 + 100 + 50);
  check('context is input + both cache figures', snap.sessions[0].contextTokens, 1110);

  // Append a second response; the incremental read must pick it up without
  // dropping the first appended line.
  fs.appendFileSync(file,
    entry({ requestId: 'req_B', input: 5, cacheRead: 2000, cacheWrite: 20, output: 30 }) +
    entry({ requestId: 'req_C', input: 5, cacheRead: 2500, cacheWrite: 20, output: 30 }));
  w.scan();
  snap = w.snapshot();

  check('resume picks up both appended responses', snap.sessions[0].turns, 3);
  check('context follows the newest response', snap.sessions[0].contextTokens, 2525);

  // A subagent must contribute spend but never the main context bar.
  fs.appendFileSync(file,
    entry({ requestId: 'req_D', sidechain: true, input: 1, cacheRead: 90000, output: 10 }));
  w.scan();
  snap = w.snapshot();

  check('subagent does not hijack the context bar', snap.sessions[0].contextTokens, 2525);
  check('subagent spend is still counted', snap.sessions[0].turns, 4);

  // An unchanged file must not be re-parsed into double counts.
  w.scan();
  snap = w.snapshot();
  check('rescanning an unchanged file is a no-op', snap.sessions[0].turns, 4);

  check('metadata is carried through', snap.sessions[0].branch, 'main');
  check('rolling total matches the sum of billed tokens',
    snap.window.totalTokens, snap.sessions[0].billedTokens);

  fs.rmSync(root, { recursive: true, force: true });
}

/** The reconciliation rules across registry, transcript and hooks. */
function mergeTests() {
  console.log('');
  const now = Date.now();

  const reg = (over = {}) => Object.assign({
    sessionId: 's1', pid: 1234, cwd: 'c:\\work\\demo', name: 'demo-1',
    status: 'busy', statusUpdatedAt: now - 1000, updatedAt: now - 1000,
  }, over);
  const stat = (over = {}) => Object.assign({
    sessionId: 's1', label: 'demo', model: 'claude-opus-5',
    lastTs: now - 60000, contextTokens: 50000, contextPeak: 50000,
    billedTokens: 1000, turns: 5,
  }, over);
  const run = (regs, stats, hooks) =>
    mergeSessions(regs, { sessions: stats }, hooks, now);

  // The registry decides existence. This is the fix for a stopped session
  // showing "working" forever: it is simply no longer listed.
  let out = run([], [stat()], { s1: { state: STATES.WORKING, ts: now - 5000 } });
  check('a closed session disappears', out.sessions.length, 0);

  // Registry status drives the base state.
  out = run([reg({ status: 'busy' })], [stat()], {});
  check('registry busy reads as working', out.sessions[0].state, STATES.WORKING);
  out = run([reg({ status: 'idle' })], [stat()], {});
  check('registry idle reads as your turn', out.sessions[0].state, STATES.READY);

  // A pending permission prompt must raise an alert, and must survive the
  // registry reporting either busy or idle.
  for (const status of ['busy', 'idle']) {
    out = run([reg({ status })], [stat()], { s1: { state: STATES.PERMISSION, ts: now - 5000 } });
    check(`pending permission alerts while registry says ${status}`, out.attention.length, 1);
  }

  // Approving a prompt fires no hook; transcript progress is the only signal.
  out = run(
    [reg({ status: 'busy' })],
    [stat({ lastTs: now - 1000 })],
    { s1: { state: STATES.PERMISSION, ts: now - 20000 } });
  check('approved prompt stops alerting', out.attention.length, 0);
  check('approved prompt shows as working', out.sessions[0].state, STATES.WORKING);

  // The tool_use line written just before the prompt must not count as progress.
  out = run(
    [reg()],
    [stat({ lastTs: now - 5000 })],
    { s1: { state: STATES.PERMISSION, ts: now - 5200 } });
  check('prompt survives the tool_use line preceding it', out.attention.length, 1);

  out = run([reg()], [stat({ lastTs: now - 600000 })],
    { s1: { state: STATES.PERMISSION, ts: now - 300000 } });
  check('long-pending prompt keeps alerting', out.attention.length, 1);

  // An idle nudge says the same thing as an idle registry; it is not an alert.
  out = run([reg({ status: 'idle' })], [stat()], { s1: { state: STATES.IDLE, ts: now - 5000 } });
  check('idle nudge is not treated as a permission alert', out.attention.length, 0);

  // A brand-new session has no transcript yet and must still be listed.
  out = run([reg({ sessionId: 'fresh' })], [], {});
  check('a session with no transcript still appears', out.sessions.length, 1);
  check('a session with no transcript reports zero context', out.sessions[0].contextTokens, 0);

  // The registry name is what Claude Code itself shows.
  out = run([reg({ name: 'ai-helper-43' })], [stat()], {});
  check('registry name is used as the label', out.sessions[0].label, 'ai-helper-43');
}

/**
 * The drill-down: steps are recorded in order, tool calls are closed out by
 * their result, and subagent work is attributed to the agent that is doing it.
 */
function activityTests() {
  console.log('');
  const a = new SessionActivity();
  const t = Date.now();

  const line = (over) => Object.assign({ sessionId: 's1', isSidechain: false }, over);

  a.record(line({
    type: 'user', uuid: 'u1', parentUuid: null,
    message: { content: [{ type: 'text', text: 'please refactor the watcher' }] },
  }), t);

  a.record(line({
    type: 'assistant', uuid: 'a1', parentUuid: 'u1',
    message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'c:\\work\\demo\\watcher.js' } }] },
  }), t + 100);

  let v = a.view();
  check('a tool call becomes the live step', v.current.tool, 'Read');
  check('tool input is summarised, not dumped', v.current.text, 'watcher.js');
  check('an unfinished tool call reads as running', v.current.status, 'running');

  // The result arrives as a tool_result on a user line.
  a.record(line({
    type: 'user', uuid: 'u2', parentUuid: 'a1',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }] },
  }), t + 900);

  v = a.view();
  check('a finished tool call is marked done', v.events[0].status, 'ok');
  check('the timeline is newest first', v.events[0].tool, 'Read');
  check('the prompt is still in the history', v.events[v.events.length - 1].kind, 'prompt');

  // A Task call opens a subagent in the agent map.
  a.record(line({
    type: 'assistant', uuid: 'a2', parentUuid: 'u2',
    message: {
      content: [{
        type: 'tool_use', id: 'task_1', name: 'Task',
        input: { subagent_type: 'Explore', description: 'find the callers', prompt: 'Locate every caller of ingest()' },
      }],
    },
  }), t + 1000);

  v = a.view();
  check('a Task call adds an agent', v.agents.length, 2);
  check('the subagent is running', v.runningAgents, 1);
  check('the main thread sorts first', v.agents[0].kind, 'main');
  check('the subagent carries its type', v.agents[1].type, 'Explore');

  // Sidechain lines belong to that subagent, matched on its opening prompt.
  a.record(line({
    type: 'user', uuid: 's-root', parentUuid: null, isSidechain: true,
    message: { content: [{ type: 'text', text: 'Locate every caller of ingest()' }] },
  }), t + 1100);
  a.record(line({
    type: 'assistant', uuid: 's-1', parentUuid: 's-root', isSidechain: true,
    message: { content: [{ type: 'tool_use', id: 'tool_2', name: 'Grep', input: { pattern: 'ingest' } }] },
  }), t + 1200);

  v = a.view();
  const sub = v.agents.find(x => x.kind === 'subagent');
  check('subagent work is attributed to the subagent', sub.current.tool, 'Grep');
  check('the subagent step is tagged with its agent', v.events[0].agentId, 'task_1');
  check('the main thread is not credited with it', v.agents[0].current.kind, 'agent');

  // Billing follows the same attribution.
  a.bill(line({ isSidechain: true, uuid: 's-2', parentUuid: 's-1' }), 500);
  a.bill(line({ isSidechain: false, uuid: 'a3', parentUuid: 'u2' }), 20);
  v = a.view();
  check('subagent tokens are counted against the subagent',
    v.agents.find(x => x.kind === 'subagent').tokens, 500);
  check('main-thread tokens stay on the main thread', v.agents[0].tokens, 20);

  // The Task result closes the agent out.
  a.record(line({
    type: 'user', uuid: 'u3', parentUuid: 'a2',
    message: { content: [{ type: 'tool_result', tool_use_id: 'task_1', content: 'done' }] },
  }), t + 5000);
  v = a.view();
  check('a returned Task marks its agent done',
    v.agents.find(x => x.kind === 'subagent').state, 'done');
  check('no agents are left running', v.runningAgents, 0);

  // A line the watcher re-reads must not double up.
  const before = a.view().events.length;
  a.record(line({
    type: 'assistant', uuid: 'a1', parentUuid: 'u1',
    message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'watcher.js' } }] },
  }), t + 100);
  check('a re-read line is ignored', a.view().events.length, before);

  // The timeline must stay bounded on a long session.
  for (let i = 0; i < 200; i++) {
    a.record(line({
      type: 'assistant', uuid: `bulk-${i}`, parentUuid: 'u1',
      message: { content: [{ type: 'text', text: `step ${i}` }] },
    }), t + 6000 + i);
  }
  check('the timeline is capped', a.events.length, MAX_EVENTS);
}

/** Startup replay: an already-pending prompt must not be missed. */
function replayTest() {
  console.log('');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-replay-'));
  const file = path.join(dir, 'events.jsonl');

  // Written before the HUD starts.
  fs.writeFileSync(file,
    JSON.stringify({ ts: Date.now() - 9000, event: 'UserPromptSubmit', sessionId: 's9' }) + '\n' +
    JSON.stringify({ ts: Date.now() - 8000, event: 'Notification', sessionId: 's9',
      message: 'Claude needs your permission to use Bash' }) + '\n');

  const b = new EventBridge({ file });
  b.start();
  const state = b.snapshot().s9;
  check('prompt pending before startup is picked up', state && state.state, STATES.PERMISSION);
  b.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

function run() {
  main();
  mergeTests();
  activityTests();
  replayTest();
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
