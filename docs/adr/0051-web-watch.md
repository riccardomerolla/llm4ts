# ADR 0051: `llm4ts watch --web` — the Agent Tree in a Browser

Status: Accepted (4.3.0) · Date: 2026-11-14 · Relates to ADR 0022, ADR 0033, ADR 0050

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
- **Timing is Watch's.** A live run is re-read on a `Schedule` every
  `pollInterval` (500ms), with a `Tick`, until its trace says it ended; a replay steps on `replayGap` — min(Δt, 2s) ÷
  speed, default ×10 — which `watch` now shares.
- **Transport.** Plain Effect HTTP (`HttpRouter`, `NodeHttpServer`) on
  `127.0.0.1` and a free port: the page, `GET /api/run`, `GET /api/frame?count=`
  for scrubbing, and server-sent events on `GET /api/stream?count=&speed=` —
  one-way frames fit SSE, and the browser reconnects by itself. Pausing closes
  the stream; changing speed reopens it.
- **One wire format.** The frame and the `/api/run` body are Effect
  schemas (`packages/shell/src/WebFrame.ts`, which imports only
  `effect/Schema`). The server encodes every body and every streamed frame
  through them (`WebFrameJson`: JSON, an absent value as `null`); the page
  decodes everything it fetches or is sent through the same codecs and shows
  a decode failure on the page instead of drawing a frame it cannot trust.
- **The page is TypeScript, bundled.** Its source is
  `packages/shell/web-src/` (a DOM-lib project, `tsconfig.web.json`, checked
  by `pnpm typecheck` and `pnpm lint` like any package source). `pnpm build`
  bundles it with esbuild for the browser into `packages/shell/web/app.js`
  (`scripts/build-web.mjs`), generated and git-ignored like the shell's
  flow copies, and the build fails if the bundle would reach a `node:`
  builtin or a platform-node package. The time, clock, token and cost text
  comes from `@llm4ts/runner/Format`, the same functions the terminal tree
  prints with. On the data side the page is Effect: server-sent frames are a
  `Stream` whose `EventSource` a finalizer closes, and the replay transport
  (play, pause, step, speed, scrub, seek) is a small state machine whose
  playing fiber a pause interrupts. Drawing stays plain typed DOM functions.
- **Assets** live in `packages/shell/web/` (published with the shell), read
  as bytes at runtime next to `src/` and `dist/`: the page, its stylesheet,
  the bundle, and the Geist and Geist Mono variable fonts with their OFL
  licence, which the build copies from the `geist` package into `fonts/`.
- **Host check.** Every request whose `Host` is not `127.0.0.1:<port>`,
  `localhost:<port>` or `[::1]:<port>` for the bound port gets 403, so a
  page on another origin cannot read the run by rebinding its own name to
  127.0.0.1.
- **Content-Security-Policy.** The page is served with `default-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src
'none'`. It has no inline script and no `style` attributes in its markup:
  colours are classes, positions are set through `element.style`. Every
  answer carries `x-content-type-options: nosniff` and `cache-control:
no-store`.
- Ctrl-C (SIGINT/SIGTERM) stops listening, drops open connections (a live
  page's event stream would otherwise hold a graceful close open, and the
  browser reopens it on the same socket), shuts the server down and prints
  `detached`; the command exits 0.

## Consequences

- The page shows what the trace shows. Anyone who can reach the port sees
  the run, so it binds loopback only.
- The executors and boards views (ADR 0033) ride the same frame: each
  executor carries what `heldBy` lists and its exclusion reason, each story
  its clone (`cloneLabel`) and its tasks in the story board's column
  (`taskColumnOf`), both exported by the agent tree so the page and the
  terminal file a task alike. The flow card switches between the graph and
  the two views by its toggles or by `e` and `b`, as `onTreeKey` does;
  `?view=executors|boards` keeps the choice across a reload. The epic
  board's second column reads `running`, as the page's legend does, where
  the terminal's reads `active`.
- Not yet in the browser: the transcript tail, the expanded lane, the full
  log, selecting an executor, and keys other than space, the arrows, `e`
  and `b`.
- The page loads nothing from the network; it works offline.
- A checkout serves the page only after `pnpm build`, as it runs the CLI
  from `dist/` only after one.
- The page's times and token counts read as the terminal tree's do, from
  `@llm4ts/runner/Format`: fewer than 1,000 tokens read `950`, not `0.9k`.
  A run past an hour reads `1h15m` on both (the terminal tree printed
  `75m00s` before).
