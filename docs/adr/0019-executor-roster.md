# ADR 0019: An Executor Roster Behind Role-Based Seats

Status: Accepted · Date: 2026-09-24

## Context

A run binds exactly one connector per seat: one coder, one reasoning seat,
the reviewers, a judgment seat. The seats come from environment variables
and the flow's own defaults. `epic-stories` runs up to three stories at once,
but all of them use the same coder. The rehearsals of 2026-09-13/24 showed
what that costs:

- a local single-model server (LM Studio) queues parallel coders and cuts
  off the queued ones;
- a hosted coder hits its usage window (Codex, ~15–60 minutes at cap 2), and
  every story after it fails the same way;
- an idle on-prem server (Lemonade, reached through opencode) and a paid
  seat with capacity to spare sit unused.

The operator has several executors (a CLI harness plus a model) with
different costs, capacities and strengths. They want the run to fill its
concurrency from all of them, cheapest first, set aside the ones that are out
of quota or down, and bring them back when they return, without any flow
knowing how many executors there are.

## Decision

1. **A roster behind role-based seats.** An executor is a harness and a
   model, with the roles it may take (`planner`, `coder`, `reviewer`,
   `judge`, `verifier`), a number of slots, and a priority per role. A
   `Roster` service in `@llm4ts/flow` leases executors by role (scoped
   leases that release their slot when the scope closes) and tracks which
   are free, busy or excluded. The runner builds it from a roster file, or,
   without one, from the environment as one executor per seat, which is
   exactly today's behaviour. Flows are unchanged and agnostic: they keep
   using `context.coder`, `context.reasoning`, `context.reviewers` and
   `contextFor`, and may ask `context.roster?.forRole(role)` for a specific
   role.
2. **A coder is held; reasoning is borrowed per call.** A story (a
   `contextFor` scope) holds one coder lease for its lifetime; a flow's root
   coder is leased lazily on its first call and held for the run. Reviewer,
   judge, verifier and planner calls lease a slot for the call only, avoiding
   the executor that holds the context's coder lease (independence). An
   executor with coder and reasoning roles keeps one slot for reasoning
   (`coderSlots` defaults to `slots - 1`); when independence cannot be
   served at all, the call borrows the context's own executor and says so,
   so no configuration deadlocks.
3. **Priority, then turns.** Lower priority numbers are picked first;
   executors with equal priority take turns (the least recently leased
   first). A context that held an executor before (a resumed story) prefers
   it while it is free. No difficulty matching in this version.
4. **Exclusion is automatic, persisted, and manual too.** Only
   infrastructure signals exclude an executor, never the quality of its
   work:
   - a usage limit, until its reset time, or 30 minutes if the provider
     gives none;
   - three rate limits within 10 minutes, for 10 minutes;
   - a serving engine that is down (the ADR 0013 addendum signals), until
     its `health` URL answers, or 5 minutes without one;
   - an unavailable executor (not installed, not logged in), for the run.

   Durations are configurable per executor. Exclusions with an end time
   persist in a user-level state file, so the next run knows the limit; the
   operator can pause and resume executors with `llm4ts roster`.

5. **Handover instead of failure.** When the executor a context holds is
   excluded in the middle of a call, the context releases it, leases the
   next coder, and repeats the call there with a note that it is taking over
   another agent's work in the same working tree; at most two handovers per
   context. The chat history the flow replays, the task checkpoint and the
   worktree are the handover.
6. **Waiting is unbounded, but never hopeless.** When every executor that
   can take a role is excluded, a lease waits for the first to return,
   however long. When none can ever return (none configured for the role, or
   all excluded for the run), the lease fails typed (`RosterExhausted`) and
   `epic-stories` stops launching stories.
7. **Configuration is a file the operator owns.** JSON, validated on load:
   `~/.config/llm4ts/roster.json`, overridden entry by entry (by `id`) by
   `<repo>/.llm4ts/roster.json`. `LLM4TS_ROSTER=<path>|none` and
   `LLM4TS_EXECUTORS=a,b` (the shell's `--roster` and `--executors`) choose
   and narrow it for one run. When a roster is in force it replaces every
   seat choice of the flow and the environment. Entries reference secrets
   by variable name only (`${VAR}`); provider settings stay in each
   harness's own configuration. One server is one executor: the roster does
   not model several executors sharing one backend.
8. **Coders are agents.** An executor whose harness is an HTTP API (LM
   Studio, Ollama, OpenAI, …) may take reasoning roles only; the coder role
   needs a CLI harness that edits files and runs commands.

## Consequences

- No flow changes to benefit: any flow gains failover of its coder and
  independent review. `epic-stories` additionally sizes its launches by the
  free coder slots and records each story's executor on the board and in the
  report.
- The story judge and the `BLOCKED_ON` verifier move from one epic-wide
  reasoning seat to per-story leases (`Stories` passes the story's seats to
  both), which is what makes independence hold per story.
- pi, antigravity and copilot usage-limit messages become typed
  `UsageLimitError`s; before, they were generic provider errors no roster
  could act on.
- A run with a roster no longer has one "coder" to print; the run header
  lists the executors instead.
- The persisted exclusion state is advisory and last-writer-wins across
  concurrent runs; a stale entry costs one probe or one failed call.
- `llm4zio` has no counterpart; `docs/parity.md` records the divergence.
