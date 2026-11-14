# ADR 0051: `llm4ts watch --web` — the Agent Tree in a Browser

Status: Proposed (prototype) · Date: 2026-11-14 · Relates to ADR 0022, ADR 0033, ADR 0050

## Context

`llm4ts watch` (ADR 0022) draws the agent tree in a terminal: live, from a
finished trace, or as a replay. Some readers want the same view in a
browser, with the motion of the approved v2 design: a judge column, failure
bubbles, token dots on running edges, a scrubber over the trace.

## Decision

- **Opt-in.** `watch --web` serves the page; without `--web`, `watch` is
  unchanged. `--web` takes the trace, `--repo`, `--epic`, `--replay` and
  `--speed`; it refuses `--tail`.
- **One fold.** The server reads the trace through `resolveTraceTarget` and
  `startingTree` (Watch.ts), folds it with `reduceTree`, and projects the
  `TreeState` into a JSON frame (`packages/shell/src/WebWatchView.ts`). The
  page lays frames out; it has no reducer of its own. Story chips, lease
  counts and what an executor holds come from the tree's own `chipsOf`,
  `leaseCounts` and `heldBy`; event lines are the session log's, else the
  event's `eventPresentation` digest. What the tree does not keep (a lane's
  failed stage, its model and prompt/completion split, verdicts before the
  latest) is read from the same events beside the fold, never by changing it.
- **Timing is Watch's.** A live run is re-read every `pollInterval` (500ms)
  with a `Tick` while it runs; a replay steps on `replayGap` — min(Δt, 2s) ÷
  speed, default ×10 — which `watch` now shares.
- **Transport.** Plain Effect HTTP (`HttpRouter`, `NodeHttpServer`) on
  `127.0.0.1` and a free port: the page, `GET /api/run`, `GET /api/frame?count=`
  for scrubbing, and server-sent events on `GET /api/stream?count=&speed=` —
  one-way frames fit SSE, and the browser reconnects by itself. Pausing closes
  the stream; changing speed reopens it.
- **Assets** live in `packages/shell/web/` (published with the shell), read
  at runtime next to `src/` and `dist/`.
- Ctrl-C (SIGINT/SIGTERM) closes the server and prints `detached`.

## Consequences

- The page shows what the trace shows. Anyone who can reach the port sees
  the run, so it binds loopback only.
- Not yet in the browser: the executors and boards views, the transcript
  tail, the expanded lane, the full log, and keys other than space and the
  arrows. Their controls are drawn but disabled.
- The page loads the Geist fonts from Google Fonts, as the design does;
  offline it falls back to the system fonts.
