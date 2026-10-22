# ADR 0041: MCP Operator Server

Status: Accepted · Date: 2026-10-22 · Extends ADR 0006, ADR 0022, ADR 0023, ADR 0026

## Context

A chat agent drove `llm4ts` through local shell commands for one evening
(a Grok Bot bumping the `nightcall` repository to 2.45.0). Every look at a
log needed a command approval. The bot launched the flow with `nohup … &`,
its turn ended, and twice it could not say whether the run was alive.
Nothing told it what happened during the run. It chose seats blind, read
costs from one place and the summary from another, and repeated a commit
title that claimed green tests.

llm4ts already writes what a supervisor needs to disk: the trace, the
boards, story files, transcripts and costs. It already holds a small MCP
server for coding harnesses (`ask_user`, `approve`). What it lacks is a
process that owns runs across a client's turns and answers typed questions
about them. The design is
`docs/superpowers/specs/2026-10-22-mcp-operator-server-design.md`.

## Decision

1. **One verb, two transports.** `llm4ts mcp` starts the operator server.
   With no transport flag, or `--stdio`, it speaks MCP on stdin and stdout
   and needs no token; the client is the parent process. `--http` serves
   MCP at `/mcp`, binds `127.0.0.1` unless `--host` names another address,
   and listens on `--port` (default 4321). HTTP refuses to start without a
   token, loopback included. The token comes from `LLM4TS_MCP_TOKEN`, or
   from the file named by `--token-file` when the variable is unset. Every
   request must carry `Authorization: Bearer <token>`; the header is
   compared in constant time and a miss is a bare `401` with no body. The
   server does no TLS. Remote clients reach it through an ssh port forward
   or a TLS reverse proxy the owner runs. Both transports are Effect's
   `McpServer.layerStdio` and `McpServer.layerHttp` over one set of
   toolkits, so every tool is written once.
2. **Repositories by id.** The server serves the repositories given with
   `--repo <path>` (repeatable; the id is the directory name) or listed in
   `~/.config/llm4ts/mcp.json` as `{ "repos": [{ "id", "path" }] }`; any
   `--repo` flag replaces the file rather than merging with it. A file id
   must be a plain name (`[A-Za-z0-9][A-Za-z0-9._-]*`, as an epic id). A tool
   that touches a repository takes `repo`, the id; with one repository the
   field may be left out. The server never takes a path from the client:
   an unknown id is the typed `UnknownRepo`.
3. **Runs are supervised child processes.** `start_run` spawns the flow as
   a child `node` process through a `FlowProcess` service (start, signal,
   exit, pid; a fake for tests), the same launch the shell uses, with
   stdout and stderr piped to files. `FlowLaunch` is now the terminal
   wrapper over that service. The server allocates the run id
   (`op-<ms>-<hex>`) and passes `LLM4TS_RUN_ID` and `LLM4TS_TRACE_PATH` to
   the child; `FlowRunner` reads both, so the server knows the trace without
   guessing. The child's environment is the server's plus the typed knobs:
   `executors` becomes `LLM4TS_EXECUTORS`, `pack` becomes `LLM4TS_PACK`,
   `coder` becomes `LLM4TS_CODER`. A client cannot set any other variable.
4. **The registry lives outside the checkout.** Per repository the server
   keeps `${XDG_STATE_HOME:-~/.local/state}/llm4ts/mcp/<repoId>/`, never
   `<repo>/.llm4ts/`, because coders have deleted that directory and flows
   have committed it. It holds `runs.jsonl` (one `OperatorRun` per state
   change, the latest line wins: run id, flow, argv, typed knobs, pid,
   trace path, state `starting | running | exited | interrupted | lost`,
   exit code or signal, times) and `runs/<runId>/stdout.log` and
   `stderr.log`. The run's trace stays in the repository's `.llm4ts/` as
   for any run.
5. **Lifecycle.** The children live in the server's scope. `stop_run` sends
   SIGINT, waits a grace period (30 s), then sends SIGTERM; the registry
   records the run as `interrupted`. Stopping the server (its own first
   SIGINT or SIGTERM) stops every child the same way before it exits; a
   second signal exits at once with 130 or 143. Only the first `stop` of a
   run signals; a repeated or concurrent one waits on the same outcome,
   because a second SIGINT kills a flow at once. Children start in their
   own process group, so a Ctrl-C on the server's terminal or a
   whole-group kill reaches only the server, which then stops each child
   once. The child's environment never carries `LLM4TS_MCP_TOKEN`. On
   start, a registry entry still `starting` or `running` whose pid is gone
   is marked `lost`; its trace and logs stay readable. An active entry no
   live handle backs (a run that outlived an earlier server) is re-checked
   whenever a read, `start_run` or `stop_run` meets it: once its pid is
   gone it becomes `lost`; while it lives it still holds its repository,
   and `stop_run` signals it by pid (SIGINT, then SIGTERM after the grace)
   and records `interrupted` when it ends. A later `start_run` with the same flow and
   target resumes from the run's durable files, as rerunning `llm4ts run`
   does. Supervised children were chosen over re-adopting detached
   processes, because the lost handle is the failure this server removes.
6. **Graceful SIGINT for every flow.** `runFlowMain` installs a handler:
   the first SIGINT interrupts the root fiber, so finalizers run (leases
   released, worktrees left consistent) and the trace ends with
   `RunEnded{interrupted}`; the second exits at once with 130. SIGTERM
   counts the same (its second exits 143), so a supervisor's or init
   system's stop ends the trace too. The terminal
   re-raises SIGINT only when no other listener remains, so the flow's
   handler is not bypassed. This changes Ctrl-C in `llm4ts run` and the
   tree UI's interrupt key for every flow.
7. **One writing run per repository.** A second `start_run` on a
   repository with a flow already `starting` or `running` is the typed
   `RunInProgress`, naming the running id, unless the server was started
   with `--parallel-runs <n>`. `epic-retro` only reads run state and is
   exempt, so a retro on the last run can start while an epic runs.
   `start_run` takes an optional `requestId`; a repeat with the same id
   returns the run it already started.
8. **Tools.** Names are `snake_case`; every input and output is an Effect
   schema emitted into `tools/list`, and expected failures are
   `Schema.TaggedError`. Where a sentence helps a chat reply, an output
   carries `summary` next to the structured fields, never instead of them.
   Always listed:
   - `preflight`: connectors with availability, `authStatus` and its
     provenance `probe` (`version` means only `<cli> --version` ran and
     proves no live session; never a bare valid), roster executors with
     `disabled` and their health URL probed, the Node and llm4ts versions.
     It answers from the doctor's report, now collected apart from its
     text renderer.
   - `list_flows` (flows with tier, description, kit), `list_epics` (title,
     story count, board, last run), `list_runs` (the registry merged with
     runs found in traces, newest first; a trace-only run has flow `?`).
   - `run_status`: state, elapsed, lanes, stories board, tokens and cost so
     far, warnings and `summary`, from the trace folded with the watch
     TUI's `reduceTree`. The sentence comes from `summarizeTree` in
     `runner`, one pure function the watch header may adopt later.
   - `run_wait`: a long poll on the trace (500 ms cadence) that returns the
     meaningful events after `sinceSeq` (`StoryStatusChanged`,
     `StageFailed`, `Aborted`, `CapabilityUnenforceable`,
     `ExecutorExcluded`, `ExecutorHandedOver`, `StoryJudged`, `Began`,
     `RunEnded`) as soon as one appears or the run stops, else after
     `timeoutSeconds` (default 120, at most 300), with the new `seq`, the
     outcome when ended, and `summary`.
   - `run_events` (raw trace lines after `sinceSeq`, by kind, bounded by
     `limit`), `run_log` (last lines of a supervised run's stdout and
     stderr), `transcript_tail` (last entries of a lane's transcript,
     optionally one role).
   - `story_detail`: one story's durable state, board entry, plan tasks,
     findings, last judge verdict and gate logs.
   - `diagnose`: for an epic run with `story`, the single-story retro digest
     (`renderStoryDigest`), gate log tails and the lane's transcript tail;
     for any other run, the failing stage or task from the trace, the plan's
     task checkboxes and the transcript tail. A plain run has no gate log
     files: its gate output is in the trace's `Info` lines, so only a story
     diagnosis carries gate log tails. Both shapes
     are bounded by `chars` (default 12000). Plain runs are covered because
     the motivating session ran `implement`, which has tasks and no stories.
   - `costs`: for one run, the trace fold as `total` with the `costs.jsonl`
     ledger figure beside it as `ledger` and a `differs` flag; without a run
     id, the repository's costs over every trace, as `llm4ts costs` reports.
   - `profile` (where a run's time went) and `retro_list` (an epic's retros
     with their approval and applied state).

   Listed only when allowed at start: `start_run`, `stop_run` and
   `retro_start` with `--allow-run`; `approve` with `--allow-approve`.
   `approve` takes `kind`, an enumerated set that holds only `retro`, plus
   the epic and the retro's run id; the server resolves the path and ticks
   the `- [x] Approved` marker. A tool not allowed is never registered, so
   it is absent from `tools/list`, and a call to it is answered by the MCP
   layer as an unknown tool (`InvalidParams`). Each act handler also checks
   the configuration itself and answers the typed `NotAllowed`, as defence
   in depth.

9. **Every client value is validated before argv or the environment.**
   `pack` is a kit or `kit/pack` name with no `.` or `..` segment; `epic`,
   `coder` and each executor are ids; `land` is a branch name; `task` may
   not start with `-` (it would parse as a flag) or `@` (the flow parser
   reads `@<path>` as a prompt file on the server). `flags` is an allowlist
   of shapes: `--flag`, `--flag=value`, or a plain value right after a
   flag. These flags are reserved and refused in `flags`: `--repo`, `-C`,
   `--prompt-file`, `--epic`, `--land`, `--judge-rounds`,
   `--merge-revisions`, `--allow-mutating`, `--yes`, `--env`, `--target`. A
   refusal is the typed `InvalidKnob`.
10. **Secrets.** The token is never logged, written to disk or echoed in
    an error. The registry holds argv and typed knobs only; the child's
    environment is written nowhere. The HTTP listener logs one line per request: the
    JSON-RPC method, the tool name for `tools/call`, the duration and the
    status. Never the arguments, and never the body of a request the token
    check refused. Over stdio every log line goes to stderr, since stdout
    carries the protocol. Tool outputs come from the trace and transcript
    readers, which keep ADR 0026's content-off defaults; `run_log` is the
    only raw channel, and it is the flow's own stdout and stderr.
11. **Two MCP servers coexist.** `packages/flow/src/McpServer.ts` and
    `runner/McpStdio.ts` keep serving `ask_user` and `approve` to coding
    harnesses, and the Gemini bridge keeps its own handler. The operator
    server is a separate toolkit on Effect's `McpServer`. The harness server
    is on the coder's critical path and covered by live harness evals; the
    operator server is new and can take Effect's implementation without
    risk to that path. Unifying the two, and registering ADR 0040's tools on
    the operator server, is a named follow-up.
12. **Where the code lives.** The server, the supervisor, the spawn service
    and the `mcp` verb live in `shell` (`OperatorServer.ts`,
    `OperatorNode.ts`, `OperatorConfig.ts`, `OperatorTools.ts`,
    `OperatorActTools.ts`, `OperatorRuns.ts`, `RunSupervisor.ts`,
    `FlowProcess.ts`), because Effect's stdio and HTTP layers need
    `@effect/platform-node`, which only `shell` depends on, and flow
    discovery and launching are already there. The pure folds live in
    `runner` (`RunReaders.ts`, `StoryReaders.ts`, `RunSummary.ts`, the
    doctor's report in `Doctor.ts`); schemas and the story digest live in
    `flow` (`OperatorSchemas.ts`, `Retro.ts`). Runner gains no dependency
    and no knowledge of `shell`.
13. **A Grok Bot template.** A Grok Bot template carries instructions,
    memories, skills and plugins, but not MCP servers or secrets. The
    deliverable is `docs/grok-bot/operator.md`: the bot's rules, two
    routines, the install steps for the server and the ssh forward, and the
    local stdio variant.

## Considered options

- Keep driving `llm4ts` through a shell. Rejected: every read is a command
  approval, the run outlives the turn that started it, and nothing is
  typed.
- Detached runs the server re-adopts after a restart. Rejected: it keeps
  the lost-handle failure. A server restart interrupts its runs; they
  resume from their durable files on the next start.
- `stop_run` kills the process as Ctrl-C did, with no flow change.
  Rejected: no finalizers run and the trace never ends. Graceful SIGINT is
  better for every flow, not only for the server.
- The server in `runner`. Rejected: runner would gain
  `@effect/platform-node` and learn about flow discovery.
- Unify with the harness MCP server now. Rejected for this release: see
  decision 11.
- Push notifications (MCP `notifications/*`, webhooks). Rejected for now:
  `run_wait` gives a client the same narration with a pull, and no client
  in view acts on pushes.
- Refuse disallowed act tools instead of hiding them. Rejected: a bot plans
  with what `tools/list` shows, so a tool it cannot use should not be
  there.

## Consequences

- Ctrl-C in any flow now ends the trace with `RunEnded{interrupted}` and
  runs finalizers; a second Ctrl-C kills it as before.
- `doctor` output is unchanged; its findings are a structured report first.
- The registry and logs live in the XDG state directory, so they survive a
  coder deleting `.llm4ts/` and never reach a commit.
- Steering a running story (retry, skip, add a story, approve a mid-run
  proposal) needs a control inbox the scheduler polls. It is the next
  project, and its tools register on this server.
- `preflight` reports a version probe as `probe: "version"`. A real
  per-seat session probe is still owed.
- Divergence from llm4zio v4.2.0, which has no operator server and no
  signal handling; recorded in `docs/parity.md` as additive.
