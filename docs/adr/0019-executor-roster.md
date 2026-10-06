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
   first). A context that held an executor before (a resumed story) keeps
   it while it is free and still ranks with the best free executor
   (amended in 2.9.7: continuity breaks ties, it never overrides a changed
   priority). No difficulty matching in this version.
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

## Amendment (2026-10-05): borrowing when the round is held by coders

Decision 2 lets a call borrow the context's own executor only when
independence "cannot be served at all". A roster whose executors' every
slot a coder may hold (one slot each — the default — or `coderSlots` equal
to `slots`) fills with story coders at the default concurrency, and each
story's per-call seat then waits for another story to end, while that
story waits the same way: the run saturates. A coder's slot frees only
when its story ends, so waiting on one is waiting on a story, not on a
call. The roster (`LeaseOptions.borrow`) now borrows the context's own
executor — whose coder is idle for the length of the call — in that case
too, as soon as every executor in the round that could take the role has
all its slots held by coders, and the event says which case it is
(`ExecutorLeased.because`: `nobody` or `held`). A call in flight on another
executor is still waited for; an executor out of the round is never
borrowed to sidestep a coder, since the story holding the slot will free
it. Independence stays the rule wherever an executor keeps a slot for
reasoning; a roster of single-slot executors trades it for progress and
is told so on every such call.

## Amendment (2026-10-06): a reasoning call waits only for a call

The rehearsal of 2026-10-06: a story coding on codex (two slots, one kept
for reasoning), claude — the only other reviewer — paused by the operator
until the morning. The story's reviewer avoided codex for independence and
waited for claude, for hours, with codex's reasoning slot free. Decision 6
("waiting is unbounded") was meant for the coder, whose work has nowhere
else to go; a per-call reasoning seat with a context of its own has. The
rule is now: a reasoning call waits only for another call to end. When no
executor outside the context's own is in the round (`out`), or every one
that is has all its slots held by coders (`held`), the context's own
executor takes the call — on a free slot of its own when it has one, as an
ordinary lease that counts, else without a slot (its coder is idle for the
length of the call). The event names the case (`ExecutorLeased.because`),
and the terminal says "on its own slot" or "on its own coder's slot".
Independence is decided per call, so the next call goes back to an
independent executor the moment one returns. The context's own executor,
out of the round itself, is still waited past unless nobody can ever serve.
