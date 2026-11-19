# Claude HUD

A small always-on-top window that tells you, at a glance, what your Claude Code
sessions are doing — so you can look away from the terminal without losing track
of them.

It shows:

- **Open sessions** — one row per session, with its Claude Code name, model and
  branch, and a live state: *working*, *your turn*, or *needs you*
- **Context fill** — a progress bar per session, so you can see a session heading
  for auto-compaction before it gets there
- **What it is doing** — the live step on each working row (*Bash · run the
  tests*), and, on a click, a drop-down with that session's **agent map** —
  the main thread plus every subagent it has launched, each with its own live
  step — and the **activity so far**: prompts, tool calls and replies, newest
  first, with each call marked running, done or failed
- **Rolling 5-hour token usage** — a ring gauge in the header (visible even when
  collapsed) plus a sparkline showing *when* the budget went
- **Permission prompts** — the window highlights and flashes the moment a session
  is blocked waiting for your approval

The window floats above every other window (including full-screen ones), is
draggable from anywhere on its surface, remembers where you put it, and collapses
to a single line.

## Install as a real app

Builds a standalone `ClaudeHUD.exe`, installs it under your user profile (no
admin rights), adds a Start Menu entry and starts it at login:

```bash
npm install
npm run package
npm run install-app          # add --no-startup to skip auto-start
```

It lands in `%LOCALAPPDATA%\Programs\ClaudeHUD`. `install-app` also re-points
Claude Code's hooks at the *installed* copy, so the HUD keeps working even if
this checkout is moved or deleted.

To remove it:

```bash
npm run uninstall-app
npm run uninstall-hooks      # optional: also remove the hooks
```

## Run from source

```bash
npm install
npm run install-hooks    # enables the permission alerts
npm start
```

Two other commands are useful:

```bash
npm test       # checks the transcript parsing rules
npm run status # prints the same data in the terminal, no window
```

`install-hooks` merges five hooks into `~/.claude/settings.json`. It keeps every
other setting and any hooks you already had, and writes a timestamped backup
first. To undo:

```bash
npm run uninstall-hooks
```

Restart any already-running Claude Code session afterwards so it picks the hooks
up. The HUD works without hooks, but then it can only infer state from transcript
activity and cannot tell you about permission prompts.

## Using it

| Action | How |
|---|---|
| Move it | Drag anywhere on the card |
| Collapse / expand | Click the chevron, or double-click the title bar |
| Hide it | Click ✕ — the tray icon brings it back |
| See what a session is doing | Click the ⌄ button on its row (or anywhere on the row) — it drops down the agent map and the activity so far; click again to close. Scroll position is kept as the panel refreshes |
| Jump to a session | Click ↗ on the row, or click an alert — focuses VS Code on that project (`code -r`), falling back to the folder if the `code` CLI is missing |
| Reset position | Right-click the tray icon → Reset position |
| Quit | Right-click the tray icon → Quit |

The tray icon turns red whenever a session needs you.

## How it works

Three independent sources are merged into one view, because each answers a
different question and none is sufficient alone.

**The session registry** (`~/.claude/sessions/<pid>.json`) is Claude Code's own
record of what is open right now: session id, cwd, pid and a live `status` of
`busy` or `idle`. This is the authoritative answer to "which sessions exist",
and it is what the session list is built from.

It has to be, because the obvious alternatives are both wrong:

- a transcript cannot distinguish a closed session from an idle one — both just
  stop growing;
- `SessionEnd` **never fires in practice**. Observed on this machine: many
  `SessionStart` events, zero `SessionEnd`. An earlier version trusted it, and a
  session you had stopped kept showing "working" indefinitely.

A leftover file from a crashed session still lists its pid, so liveness is
checked with a signal-0 probe rather than trusted.

**Transcripts** (`~/.claude/projects/**/*.jsonl`) are append-only JSONL that
Claude Code writes as it works. They supply the token numbers and the proof of
forward progress, carrying `usage` for every API response. They reach tens of
megabytes, so
each one keeps a byte cursor and only newly appended bytes are ever parsed; the
first read looks at the last 4 MB so startup stays fast.

Two details matter for correctness:

- A single API response is written as **several** JSONL lines (thinking, text,
  tool_use), each repeating the same `usage` object. Billing is therefore
  deduplicated by `requestId`, or the totals come out 2–3× too high.
- Subagent (`isSidechain`) responses have their own context, so they are counted
  toward spend but never used for the main session's context bar.

The same lines also carry what the session is *doing*: every `tool_use` block
and the `tool_result` that closes it, every reply, and every `Task` call, which
is what opens a subagent in the agent map. Subagent lines name no agent, so they
are chained by `parentUuid` back to the sidechain's opening prompt and matched
to the `Task` call that supplied it — which is how a subagent's steps and tokens
end up against the subagent rather than the main thread. Both the timeline and
the agent map are capped per session, so a long-running session cannot grow
without bound.

**Hooks** tell the HUD what a session is doing *right now*, which a transcript
cannot show. `hooks/claude-hook.js` appends one line to
`~/.claude/ai-helper/events.jsonl` per event, and the HUD tails it:

| Hook | Meaning in the HUD |
|---|---|
| `UserPromptSubmit` | working |
| `Stop` | your turn |
| `Notification` | **needs you** — permission prompt or idle nudge |
| `SessionStart` / `SessionEnd` | appears / disappears |

Neither source is sufficient alone, and the gap matters: **no hook fires when
you approve a prompt.** Hook state on its own would stay stuck on "needs you"
for the rest of the turn. So the transcript advancing past the hook event is
what clears the alert — with a short grace period, because the `tool_use` line
that *triggered* the prompt is written just before it. The HUD also replays the
tail of the event log on startup, so a session already sitting on a prompt when
you launch it is reported rather than missed.

The hook shim is deliberately defensive: it never writes to stdout, swallows all
errors and always exits 0, because it runs inside Claude Code's own request path
and must never be able to disrupt a session.

### Numbers, and what they actually mean

- **Context bar** — `input + cache_read + cache_creation` of the session's most
  recent response, against the model's context window.

  The window size is **inferred, not assumed**. Hard-coding 200k turned out to be
  wrong: real `claude-opus-5` sessions here were observed holding 257k. So each
  session starts at an assumed 200k and is promoted to the next known tier
  (500k, then 1M) if it is ever seen holding more than that. An inferred ceiling
  is shown with a `~`. Compaction makes the current value drop, so the *peak* is
  what the inference uses.
- **Last 5h** — `input + cache_creation + output` summed over a rolling 5-hour
  window. Cache reads are excluded because they bill at a fraction of input, so
  this approximates tokens charged at full rate. The denominator is a **personal
  budget, not an official limit** — it only exists to give the bar a meaning.
  Change it in `~/.claude/ai-helper/ui-state.json` (`windowBudget`).

## Configuration

`~/.claude/ai-helper/ui-state.json`, created on first run:

```json
{
  "x": 1540, "y": 24,
  "collapsed": false,
  "windowBudget": 3000000,
  "alertSound": true,
  "openWith": "editor"
}
```

Set `openWith` to `"folder"` if you would rather clicks reveal the folder in
Explorer than focus VS Code.

Timing and thresholds (poll interval, how long a session counts as active, the
context window size) live in [src/main/config.js](src/main/config.js).

## Layout

```
src/main/index.js      Electron main: window, tray, IPC
src/main/sessions.js   Claude Code's live session registry (what is open now)
src/main/watcher.js    Transcript tailing, context + usage math
src/main/events.js     Hook event log tailing, per-session state machine
src/main/merge.js      Reconciles all three (Electron-free, so testable)
src/main/activity.js   Per-session agent map and step timeline (Electron-free)
src/main/preload.js    The renderer's entire API surface
src/renderer/          The window itself (plain HTML/CSS/JS, no framework)
hooks/claude-hook.js   What Claude Code invokes
scripts/install-hooks.js
scripts/package.js     npm run package
scripts/install-app.js npm run install-app
scripts/make-icon.js   Generates the tray PNGs and .ico (no binary assets)
scripts/selftest.js    npm test
scripts/status.js      npm run status
```

One packaging detail worth knowing: the app ships as `app.asar`, but
`hooks/claude-hook.js` is deliberately copied *outside* the archive, to
`resources/hooks/`. Claude Code runs the hook as `node <path>`, and an external
process cannot read inside an asar — left in the bundle, permission alerts would
fail silently.

The renderer runs with `contextIsolation` on and no Node access.

## Troubleshooting

**`Electron failed to install correctly`** — `npm install` downloads a ~110 MB
binary from GitHub, and on a slow or flaky connection it dies with `ECONNRESET`,
after which npm rolls `node_modules` back. Install the packages without the
binary, then fetch it yourself with a resumable download:

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install

V=$(node -p "require('electron/package.json').version")
curl -L --retry 20 --retry-all-errors --continue-at - \
  -o electron.zip \
  "https://github.com/electron/electron/releases/download/v$V/electron-v$V-win32-x64.zip"

unzip -q electron.zip -d node_modules/electron/dist
echo "electron.exe" > node_modules/electron/path.txt
```

Re-running the `curl` line resumes where it left off, so a dropped connection
costs nothing.

**The window never appears** — if `ELECTRON_RUN_AS_NODE` is set in your shell,
Electron runs as plain Node and no GUI is created. Unset it before `npm start`.

## Notes and limits

- Windows-focused (that is where it was built and tested). Nothing is
  deliberately platform-locked; the tray and always-on-top flags are the parts
  most likely to need attention on macOS or Linux.
- It reads your transcripts and writes only to `~/.claude/ai-helper/`. Nothing
  leaves the machine.
- It cannot *answer* a permission prompt — it tells you one is waiting and which
  project it belongs to. Approving still happens in the terminal.
- Sessions are listed while they are open, and disappear when closed. The token
  numbers come from transcript tails, so a session open for longer than the last
  4 MB of its transcript shows totals from that point on.
