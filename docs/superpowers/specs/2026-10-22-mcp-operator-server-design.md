# MCP operator server and a Grok Bot operator template

Date: 2026-10-22 · Status: draft for approval · Builds on ADR 0006 (shell),
ADR 0013 (parallel stories), ADR 0022 (agent tree / watch), ADR 0023
(epic-retro), ADR 0040 (pull-model context over MCP, proposed)

## 1. Intent

A chat agent should be able to run llm4ts the way a colleague would: ask
whether the machine is ready, start a flow, be told what happens while it
runs, look into a failed story, read the bill, and start the retro, without
ever typing a shell command or parsing prose.

The trigger is a real session. A Grok Bot ("flowsmith") was asked to bump
the `nightcall` repository to llm4ts 2.45.0 and drove `llm4ts` through local
shell commands. The transcript shows what that costs:

- every look at a log file needed a "can run commands on your computer"
  approval, dozens over one evening, and one approval failure stalled the bot;
- the bot launched the flow with `nohup … &`, its turn ended, and twice it
  could not say whether the run was alive ("the rerun got cut off before it
  reported back", "my launcher was cut off before its first command");
- nothing told it anything during the run; it learned about an expired OAuth
  session, a pi coder that could not start, and 26 open review issues by
  going back to look, once hours later;
- it chose seats blind, not knowing the roster would hand the coder seat to a
  local executor that would crash, and learned about `--executors` afterwards;
- it read costs from one place and the run summary from another, and a commit
  title claimed green tests that failed on load.

Grok Bot, like Cursor and Claude Code, speaks MCP. Grok Bot's own
engineering playbook has bots supervising coding agents by reading
transcripts, queueing messages and interrupting runs, and escalating to the
human only when they lack permission. llm4ts already writes everything such a
supervisor needs to disk (trace, board, story files, transcripts, costs) and
already contains a small MCP server. This design turns that into a product
surface: one long-running `llm4ts mcp` process that owns runs and answers
typed questions about them, plus a Grok Bot template that uses it.

The same server serves any MCP client. The watch TUI and the shell do not
change in this project; they may consume the server later.

## 2. Goals, non-goals, anti-goals

### Goals

1. A bot never needs a shell to operate llm4ts: preflight, start, observe,
   diagnose, cost, retro, approve are all tools.
2. The server owns the run processes it starts: it knows whether a run is
   alive from its own state, not from a log, across the bot's turns.
3. Feedback during a run: a status tool and a long-poll wait tool, so a bot
   can narrate a run without push notifications.
4. A failed story can be investigated by the bot itself from material the
   server returns; the server makes no model calls.
5. Two transports from one verb: stdio (a client on the same machine) and
   HTTP (a client elsewhere, typically through an ssh tunnel), both built on
   the MCP server shipped inside the pinned Effect release.
6. One server can serve several repositories on one machine.
7. A published Grok Bot template, with install notes for the server, that a
   user adds to Grok Bot and talks to.

### Non-goals (this project)

- Steering a running story: retry, skip, add a story, approve a mid-run
  proposal. That needs a control inbox the scheduler polls; it is the next
  project and this server is where its tools will be registered.
- An investigator seat inside llm4ts. The bot is the model.
- Push notifications (MCP `notifications/*`, webhooks). Pull only.
- Changes to the watch TUI or the shell menu.
- Fixing the llm4ts defects the transcript exposed (section 9). They are
  listed so they are not forgotten, and they are separate work.
- Unifying the harness-facing MCP tools (`ask_user`, `approve`) and the
  Gemini bridge onto the new server (section 7).

### Anti-goals

Even if it technically worked, the project has failed if:

- a bot can start runs or approve retros with nothing but the bearer token,
  on a server that was not started with those tools allowed;
- the server, its registry, its logs, its traces or its error messages ever
  carry a token, a provider credential or an environment secret;
- the server binds a non-loopback address unless asked by name;
- a tool answer makes the bot parse prose to find a number or a state;
- the server makes a model call, holds provider credentials, or needs a
  roster of its own;
- a run started by the server can only be understood by reading the server's
  log, i.e. anything a tool reports must also be in the run's own files.

## 3. Constraints

- Effect `4.0.0` exact pin; the MCP server is `effect/unstable/ai/McpServer`
  from that release. Its stdio and HTTP layers need the Node services from
  `@effect/platform-node`, which `shell` already depends on; no package gains
  a new dependency.
- Package graph `core → flow → runner → js | shell`. The server, the process
  supervisor and the HTTP listener are Node and CLI concerns and live in
  `shell`, which already owns flow discovery and flow launching (ADR 0006).
  Pure folds and summaries over run files live in `runner`; schemas and the
  per-story digest live in `flow`. Runner keeps zero knowledge of shell.
- Schemas at the boundary: every tool input and output is an Effect schema
  with a JSON schema emitted into `tools/list`. Expected failures are
  `Schema.TaggedError`.
- Secrets: never in process arguments, logs, traces, the run registry or
  error messages (CLAUDE.md). The token is read from the environment or a
  file.
- Tests are deterministic with `@effect/vitest` and the in-src fakes; CI
  needs no network, no credentials, no provider CLI. The HTTP transport is
  tested in-process against the Effect router, and the supervisor against the
  core process fake.
- Divergence from llm4zio v4.2.0 is additive and recorded in
  `docs/parity.md`; the decisions below become ADR 0041.

## 4. Decisions

### D1. One verb, two transports

`llm4ts mcp` starts the operator server.

- `llm4ts mcp` with no transport flag, or `--stdio`: MCP over stdin/stdout.
  No token; the client is the parent process. This is how a local Grok Bot,
  Claude Code or Cursor adds it.
- `llm4ts mcp --http [--host 127.0.0.1] [--port 4321]`: MCP over HTTP at
  `/mcp`. Default host is loopback. A token is mandatory on HTTP, from
  `LLM4TS_MCP_TOKEN` or `--token-file <path>`; the server refuses to start
  on HTTP without one, loopback included. Every request carries
  `Authorization: Bearer <token>`, compared in constant time; a miss is a
  bare 401.
- Recommended remote exposure is an ssh port forward from the client machine
  to the loopback port; a reverse proxy with TLS is the user's alternative.
  The docs say this; the server does not do TLS.

Both transports come from `McpServer.layerStdio` and `McpServer.layerHttp`
over one toolkit, so the tools are written once. `layerStdio` takes the
`Stdio` service from `@effect/platform-node`; `layerHttp` registers routes
on an `HttpRouter`, and `NodeHttpServer` from the same package listens. The
Gemini bridge's hand-rolled Node listener and its constant-time bearer check
are prior art if the Effect server layer proves unsuitable.

### D2. Repositories

The server serves one or more repositories, given at start:
`--repo <path>` repeated, or `~/.config/llm4ts/mcp.json` with
`{ "repos": [{ "id": "nightcall", "path": "/abs/path" }] }`. Each tool that
touches a repository takes `repo` (the id). With exactly one repository the
field is optional. A path outside the configured roots is refused with a
typed error; the server never takes a path from the client.

### D3. Runs are supervised child processes

The server starts a flow the way the shell does today, as a child `node`
process running the flow script with type stripping and the resolve
fallback, but with stdio piped to files instead of the terminal. The spawn
becomes a small `FlowProcess` service in `shell` (start, signal, exit
handle, pid) with a fake for tests; the core process fake cannot stand in,
since it has no pid, signal or exit handle. `FlowLaunch` becomes the
terminal-facing wrapper over the same service (SIGINT relay, `stty`
restore).

Per started run the server keeps its state outside the checkout, under
`$XDG_STATE_HOME/llm4ts/mcp/<repoId>/` (default
`~/.local/state/llm4ts/mcp/<repoId>/`), never under `<repo>/.llm4ts/`: a
coder has deleted that directory and flows have committed it (section 9),
and the registry must survive both. There it keeps:

- `runs.jsonl`: one line per run, append-only, schema `OperatorRun`:
  `runId`, `repo`, `flow`, `args` (the flow argv as given, which by rule holds
  no secrets), `knobs` (the typed options of `start_run`), `startedAt`,
  `pid`, `tracePath` (filled once known), `state`
  (`starting | running | exited | interrupted | lost`), `exitCode`,
  `endedAt`. State changes append a new line; the latest line wins.
- `runs/<runId>/stdout.log` and `stderr.log`.

Lifecycle:

- `runId` is allocated by the server before spawn and passed to the child
  as `LLM4TS_RUN_ID`, together with `LLM4TS_TRACE_PATH`. `FlowRunner`
  already accepts `runId` and `tracePath` as options; it gains the reading
  of those two variables. No newest-trace guessing.
- The child runs in the server's Effect scope. Stopping the server stops its
  children (see "Stopping a run" below); the registry marks them
  `interrupted`. A later `start_run` with the same flow and target resumes
  from the run's durable files, as rerunning `llm4ts run` does today. This
  is deliberate: a run the server does not own is the problem this project
  removes.
- On start, registry entries still `running` whose pid is gone are marked
  `lost`; their trace and logs remain readable.
- Stopping a run. Today no flow handles SIGINT: Node terminates the process
  with no fiber interruption, no finalizers, and no `RunEnded` line;
  resumption works only because story and plan state are durable files. The
  design asks for a graceful path: the flow entry point installs a SIGINT
  handler that interrupts the root fiber once, so finalizers run (leases
  released, worktrees left consistent) and the trace ends with
  `RunEnded{interrupted}`; a second SIGINT terminates at once. `stop_run`
  sends SIGINT, waits a grace period (default 30 s), then SIGTERM, and the
  registry records which. This changes Ctrl-C in `llm4ts run` and the tree
  UI's interrupt key for every flow, for the better, and is recorded in ADR
  0041 and `docs/parity.md` with its own tests. See section 7 for the
  alternative if this is not wanted.
- Concurrency: one running flow that writes the checkout per repository by
  default; a second `start_run` on the same repository is refused with a
  typed error naming the running `runId`, unless the server was started with
  `--parallel-runs <n>`. Flows that only read the run state, today
  `epic-retro`, are exempt, so a retro on the previous run can start while
  an epic runs.

The environment of the child is the server's environment plus the typed
knobs (D4) rendered to the `LLM4TS_*` variables the flows already read. The
client cannot set arbitrary environment variables.

### D4. Tools

Names are `snake_case`. Every tool has an input schema and an output schema.
Outputs are structured; where a human sentence helps a chat reply, the
output carries a `summary: string` field produced by a pure function, next
to the structured fields, never instead of them.

Read tools, always listed:

| Tool              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Answers from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight`       | Is this machine ready to run?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the doctor's findings, refactored into a structured report plus the existing text renderer (the `doctor` command keeps its output); the roster document with per-executor `disabled` and `cooldown`, and the live result of each executor's health URL probed with a short timeout, as the roster itself probes it; the Node and llm4ts versions. Each connector's `authStatus` is reported with its provenance: today it comes from a version probe, so it is labelled `probe: "version"` and the schema's comment and the bot's instructions say a version probe does not prove a live session. Never a bare `Valid`. A real per-seat auth probe stays in section 9. |
| `list_flows`      | Which flows can be started, with their tier (project, global, built-in) and description.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the shell's flow catalog (the server lives in shell, D9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `list_epics`      | Epics under `.llm4ts/epics/` with plan title, story count, board summary, last run.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `plan.md`, `board.json`, `runs.jsonl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `list_runs`       | Runs the server started plus runs found in traces, newest first, with state and outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the registry, `runs.jsonl` of each epic, `RunEnded` in traces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `run_status`      | One run now: state, elapsed, lanes (story, status, current work, executor, last event age), stories board, tokens and cost so far, open capability warnings, `summary`.                                                                                                                                                                                                                                                                                                                                                                      | the trace folded with the same reducer the watch TUI uses (`reduceTree`), the board, the registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `run_wait`        | Long poll. Returns the next meaningful event after `sinceSeq`, or times out (`timeoutSeconds` ≤ 300, default 120). Meaningful: `StoryStatusChanged`, `StageFailed`, `Aborted`, `CapabilityUnenforceable`, `ExecutorExcluded`, `ExecutorHandedOver`, `StoryJudged`, `Began`, `RunEnded`, and process exit. Returns the events, the new `seq`, and `run_status`'s `summary`.                                                                                                                                                                   | the trace tail, polled on the watch cadence, and the supervisor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `run_events`      | Raw trace lines after `sinceSeq`, optionally filtered by kind, bounded by `limit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the trace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `run_log`         | Last `lines` of the child's stdout/stderr.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | the registry's log files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `story_detail`    | One story: durable state, board entry with reason, plan with task checkboxes, findings, last judge verdict, gate log index, branch and worktree.                                                                                                                                                                                                                                                                                                                                                                                             | `stories/<id>.*`, `board.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `diagnose`        | What a bot needs to say why a run or a story failed. Input: `runId`, optional `story`. For an epic run with a story: the single-story retro digest (ADR 0023's renderer run for one story), the last gate log tails, the lane's transcript tail. For any other run, or an epic run without a story: the failing stage or task from the trace (`StageFailed`, `Aborted`, `Stalled` signals), the plan's task checkboxes, the gate log tails, the run lane's transcript tail. Character budget as an input, default the retro's per-story cap. | `Retro.ts` readers with a per-story digest function exported for it; the trace fold and the plan store for the run-level shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `transcript_tail` | Last `entries` of a lane's transcript, optionally one role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `.llm4ts/transcripts/<runId>/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `costs`           | What a run or the repository has cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the same trace fold `llm4ts costs` uses (it folds traces by design, see `Costs.ts`), reported as `total`; the `costs.jsonl` ledger line, when present, alongside as `ledger`, with a `differs` flag when the two disagree by more than rounding, so the bot states one number and can say it is disputed. Why they disagree is section 9.                                                                                                                                                                                                                                                                                                                              |
| `profile`         | Where a run's time went.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the profile fold over `Timed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `retro_list`      | Retros for an epic with approval state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `retro/`, `retros.jsonl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Act tools, listed only when allowed at start:

| Tool          | Flag              | Purpose                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_run`   | `--allow-run`     | Start a flow. Input: `repo`, `flow`, `task?` (the task text), `epic?`, `pack?`, `executors?` (ids), `coder?`, `judgeRounds?`, `mergeRevisions?`, `land?`, `flags?` (extra argv, strings). Output: `runId`, `tracePath?`, `pid`.                                                                                                                                     |
| `stop_run`    | `--allow-run`     | Interrupt a run (D3).                                                                                                                                                                                                                                                                                                                                               |
| `retro_start` | `--allow-run`     | Start `epic-retro` for an epic (and optionally a run); a `start_run` with the flow fixed.                                                                                                                                                                                                                                                                           |
| `approve`     | `--allow-approve` | Tick the `- [x] Approved` marker on an artefact. Input: `repo`, `kind`, and the artefact's id; the server resolves the path per kind, never the client. `kind` is an enumerated set that holds only `retro` in this release; epic briefs, refine proposals and pack upgrades use the same marker and can be added as kinds later without changing the tool's shape. |

Not-allowed tools are absent from `tools/list`, so a bot cannot discover
and try them. A call to one anyway is a typed `NotAllowed` error.

Idempotency: `start_run` takes an optional `requestId`; a repeat with the
same id returns the existing `runId` instead of starting a second run. This
covers the transcript's "my launcher was cut off" case.

### D5. A status sentence shared with watch

`run_status.summary` and `run_wait.summary` come from one pure function in
`runner` over `TreeState`, e.g. "epic-stories, 42 min: 3 stories done, 1
active (payments, codex, reviewing), 1 failed (notifications: judge not
cleared after 2 revisions), $12.40". The watch TUI's header may adopt it
later; nothing in watch changes now.

### D6. Secrets and what a client can see

- The token is compared, never stored in memory longer than needed, never
  logged, never echoed in an error.
- The registry stores argv and typed knobs only. The child's environment is
  never written anywhere.
- Tool outputs pass through the existing trace and transcript readers, which
  already honour the content-off defaults of ADR 0026; `run_log` is the only
  raw channel and it is the flow's own stdout, which by the repo's rules
  holds no secrets.
- The HTTP listener logs one line per request: method, tool name, duration,
  outcome. No arguments.

### D7. Relationship to the existing MCP code and ADR 0040

`packages/flow/src/McpServer.ts` and `runner/McpStdio.ts` serve two tools
to coding harnesses over stdio; the Gemini bridge reuses the request handler
over HTTP. They stay as they are in this project. The operator server is a
separate toolkit on Effect's `McpServer`; the two do not share a transport
yet. Unifying them, and registering ADR 0040's `graph_*` and `orientation`
tools on the operator server when that ADR is built, is a named follow-up.
The reason to not unify now: the harness-facing server is on the coder's
critical path and is exercised by live harness evals; the operator server is
new and can adopt Effect's implementation without risk to that path.

### D8. The Grok Bot template

A Grok Bot template carries instructions, memories, skills and plugins, and
excludes MCP servers, scripts and secrets. So the deliverable is:

1. `docs/grok-bot/operator.md`: the template's contents and the install
   steps. It is written so the bot's owner pastes the instructions in and
   follows the steps; the template on Grok Bot's side is published from such
   a bot with "Share as Template" as a public link, and the doc records the
   link once published.
2. Instructions for the bot, in prose, covering: call `preflight` before
   `start_run`; prefer the server's tools over any shell command when the
   server is reachable; narrate a run by looping on `run_wait` and reporting
   each meaningful event in one line; on a failed story call
   `diagnose` and explain the cause before proposing a rerun; take
   costs from `costs`, never from a run's prose; treat a flow's claim of
   green gates as a claim and check the gate output in `story_detail`; ask
   the human before `start_run` when the estimated cost or scope is large,
   and always before `approve`; never work around a missing tool with a
   shell.
3. Routines: a 30-minute check (`list_runs`, then `run_status` on anything
   running, report only changes) and a morning digest (`list_epics`,
   `costs`, `retro_list`).
4. Install steps: install `@llm4ts/shell` on the machine that holds the
   repositories; create the token file; start
   `llm4ts mcp --http --repo … --allow-run` under the user's supervisor of
   choice; from the bot's computer open the ssh port forward; add the server
   in Grok Bot's MCP settings with the URL and the bearer header; verify
   with `preflight`.
5. The `using-llm4ts` skill gains a section: when an llm4ts MCP server is
   configured, use its tools instead of `npx -y @llm4ts/shell run …`.

### D9. Where the code lives

- `packages/flow/src/`: `OperatorSchemas.ts` (tool input/output schemas,
  `OperatorRun`), the exported per-story digest in `Retro.ts`.
- `packages/runner/src/`: `RunSummary.ts` (D5), `RunReaders.ts` (the pure
  folds the read tools answer from: status from `reduceTree`, costs, profile,
  story files, run-level diagnosis), `Doctor.ts` split into report and
  renderer, `FlowRunner` reading `LLM4TS_RUN_ID` and `LLM4TS_TRACE_PATH`,
  the SIGINT handler in the flow entry point.
- `packages/shell/src/`: `FlowProcess.ts` (the spawn service and its fake),
  `RunSupervisor.ts` (registry under the state dir, scope, stop, lost
  detection, idempotency), `OperatorTools.ts` (the toolkit, wiring readers,
  catalog and supervisor), `OperatorServer.ts` (Effect `McpServer` layers
  over `@effect/platform-node`, token check), the `mcp` command in
  `Cli.ts`; `FlowLaunch.ts` becomes the terminal wrapper over `FlowProcess`.
- `docs/adr/0041-mcp-operator-server.md`, `docs/grok-bot/operator.md`,
  `docs/parity.md` note, `CHANGELOG.md`, `skills/using-llm4ts/SKILL.md`.

## 5. What done looks like

- `llm4ts mcp --stdio` added to Claude Code or Cursor lists the read tools;
  with `--allow-run` it starts and stops a flow on a fixture repository.
- `llm4ts mcp --http --repo … --allow-run` refuses to start without a
  token, answers 401 without one, and serves the same tools with one.
- The nightcall session replays without a single shell command: `preflight`
  shows the roster and its health, `start_run` starts `implement` with
  `executors: ["claude","codex"]`, a `run_wait` loop reports each stage, the
  failed task is explained from `diagnose` at run level, `costs` gives one
  number. On an epic run, `diagnose` with a story returns the retro digest
  for that story.
- Stopping the server interrupts its runs and marks them; restarting it
  marks dead ones `lost`; a repeated `start_run` with the same `requestId`
  does not start a second run.
- Deterministic tests cover: tool schemas and `tools/list` filtering by
  allow flags; the supervisor with the `FlowProcess` fake (start, exit,
  interrupt, lost, repeated `requestId`); the HTTP token check in-process;
  `run_wait` returning on a meaningful event and on timeout against a
  written trace; the status sentence; `diagnose` on the retro fixture and on
  a plain `implement` trace; the SIGINT handler ending a trace with
  `RunEnded{interrupted}`; `preflight` never reporting a bare `Valid`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`,
  `pnpm build && node scripts/pack-smoke.mjs` pass.
- ADR 0041, the parity note, the Grok Bot doc and the skill section exist.

## 6. Left to the builder

- Exact schema field names and the JSON-schema emission for Effect's
  `McpServer` toolkit; whether tools return `structuredContent` alongside
  text (preferred when the client supports it).
- The composition of `McpServer.layerHttp` with `NodeHttpServer`, and
  whether the Gemini bridge's Node listener is reused instead.
- Poll cadence inside `run_wait` (the watch cadence, 500 ms, is the default
  assumption) and the file-tail strategy for growing traces.
- Grace periods, limits, default character budgets, and how `list_runs`
  merges the registry with runs the server did not start.
- The shape of the per-story digest export, as long as it reuses the retro's
  readers and section renderer.
- Which `LLM4TS_*` variables each typed knob maps to.

## 7. Open questions settled as the author's calls

- Supervised, not detached, children (D3). A server restart interrupts runs,
  which resume on the next start. Chosen over re-adopting detached processes
  because the lost-handle failure is the one this project exists to remove.
- Token mandatory on HTTP even on loopback (D1), because a loopback port on
  a shared server is reachable by every local user.
- One running flow per repository by default (D3), because two flows in one
  checkout fight over `.llm4ts/` and the worktree root; the flag exists for
  users who know better.
- Act tools hidden rather than merely refused (D4), so a bot's planning is
  not tempted by tools it cannot use.
- The two MCP servers coexist for one release (D7).
- The template is a public link (D8); it holds no secrets, and the server
  behind it is the owner's.
- The server lives in `shell`, not `runner` (D9), because the Node MCP
  layers, flow discovery and flow launching are already there and runner
  must not learn about shell or gain a dependency.
- The registry lives in the XDG state directory, not in the checkout (D3).
- Graceful SIGINT for every flow (D3). The alternative, if this is not
  wanted: `stop_run` terminates the process as Ctrl-C does today, the
  registry says `killed`, resumption still works from the durable files, and
  no flow changes. The author recommends the graceful path.
- `diagnose` covers both epic stories and plain runs (D4), because the
  motivating session ran `implement`, which has tasks and no stories.
- `approve` knows one kind, `retro` (D4).
- `costs` reports the trace fold as the number and the ledger beside it
  (D4).
- `epic-retro` is exempt from the one-run-per-repository rule (D3).

## 8. Sequencing

1. `FlowProcess` extraction and `RunSupervisor` with its registry, tested
   against the process fake.
2. `OperatorSchemas`, `RunSummary`, the read tools over files, with the
   per-story digest export.
3. `OperatorServer` on Effect's `McpServer`, stdio first, then HTTP with the
   token check; the `mcp` verb.
4. Act tools behind flags, `run_wait`.
5. ADR 0041, parity note, docs, skill section, template doc, CHANGELOG;
   a release.
6. Live check: Claude Code over stdio, then Grok Bot over an ssh-forwarded
   HTTP port against a real repository.

## 9. Out of scope, found on the way

The nightcall transcript exposed defects a server does not fix. Each is a
candidate for its own change:

- `llm4ts doctor` reported `claude` healthy while its OAuth session was
  expired; the probe checks the binary, not the session. A cheap authenticated
  call per seat would have saved a run.
- A pi coder ran `rm -rf .llm4ts` several times and deleted the trace of an
  earlier run. The run state directory needs protection from the coder, or a
  location outside the checkout.
- Run artefacts (`plan-*.md`, trace, an archived run directory) were
  committed by the flow, then read by reviewers at real cost ($45 for one
  run, mostly reviewers reading a 249 kB trace). `.llm4ts/` should carry its
  own `.gitignore` from the first write.
- `llm4ts costs` ($1.02) and the run's own summary ($2.95) disagreed, with
  "some events not recorded".
- A run called itself complete with "full typecheck and test suite are
  green" while every test file failed on load; a gate that counts zero tests
  as a pass, or the absence of a gate, let that through.
- The next project after this one: a typed control inbox the story scheduler
  polls (retry, skip, add a story, approve mid-run), registered as tools on
  this server, and failure reasons on `StoryStatusChanged`.
