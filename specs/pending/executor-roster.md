# Executor roster: the library

A `Roster` in `@llm4ts/flow` that leases executors (a harness plus a model)
by role, with slots, per-role priorities, automatic and manual exclusion,
persisted exclusion state, and handover of a held coder. This is the library
half; the runner wiring, the shell commands and the `epic-stories`
integration are in `specs/pending/executor-roster-flows.md`. Design record:
ADR 0019.

Driver: a run binds one connector per seat, so parallel stories share one
coder, a usage limit fails every story after it, and idle executors (an
on-prem server, a paid seat with capacity) are never used.

## Decisions (agreed 2026-09-24)

| Decision  | Choice                                                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seam      | A `Roster` service in `flow`; the runner builds it from a file or from the environment (one executor per seat). Flows stay agnostic.                                                                                 |
| Unit      | A context's coder is one held lease (a story's for its lifetime, a root context's from its first call to the end of the run); reasoning roles lease per call.                                                        |
| Roles     | `planner`, `coder`, `reviewer`, `judge`, `verifier`, declared per executor. Reasoning calls avoid the executor holding the context's coder; if none else can serve, they borrow it, marked not independent.          |
| Capacity  | `slots` per executor; `coderSlots` defaults to `slots - 1` when the executor also has a reasoning role and `slots > 1`, else `slots`. A flow's `--concurrency` stays a global cap.                                   |
| Priority  | Per role (`priority: n` or `{ coder: n, default: n }`), lower first; equal priorities take turns (least recently leased first). A preferred executor (the one held before) wins while free and ranked with the best. |
| Exclusion | Automatic on infrastructure signals only; manual pause/resume; persisted when it has an end time.                                                                                                                    |
| Waiting   | Unbounded while any eligible executor can return; typed `RosterExhausted` when none can.                                                                                                                             |
| Handover  | On an exclusion during a held coder's call: release, lease the next coder, repeat the call with a takeover note; at most 2 per context.                                                                              |
| Executors | CLI harnesses may take any role; API connectors reasoning roles only (checked by the runner, which knows the harnesses). One server, one executor.                                                                   |

## Modules

### `packages/flow/src/Roster.ts`

- Schemas:
  - `Role = "planner" | "coder" | "reviewer" | "judge" | "verifier"`.
  - `ExecutorSpec`: `id`, `harness`, `model?`, `flags?` (record), `env?`
    (record), `baseUrl?` (API harnesses), `roles`, `slots` (default 1),
    `coderSlots?`, `priority` (number or record with `default`), `health?`,
    `cooldown?` (`usageLimit`, `rateLimit`, `outage`, as duration strings),
    `disabled?`.
  - `RosterDocument`: `{ executors: ExecutorSpec[] }`.
  - `Exclusion`: `id`, `reason`, `kind` (`until` | `health` | `run` |
    `manual`), `until?` (epoch ms).
  - `RosterStateDocument`: `{ exclusions: Exclusion[] }` (versioned; `run`
    exclusions are never written).
- Pure helpers: `priorityOf(spec, role)`, `coderSlotsOf(spec)`,
  `mergeRosterDocuments(user, repo)` (repo entries replace user entries by
  `id`; `disabled: true` removes), `narrowRoster(doc, ids)`,
  `rosterViolations(doc)` (duplicate ids, no roles, slots < 1,
  `coderSlots` > `slots`, unknown role names), and
  `exclusionFor(error, spec, now, recentRateLimits)`, which maps an
  `LlmError` to an exclusion or none:
  - `UsageLimitError` → `until` `resetAt`, else now + `cooldown.usageLimit`
    (30 min);
  - `RateLimitError` → none, unless it is the third within 10 minutes →
    `until` now + `cooldown.rateLimit` (10 min);
  - a provider error for which `isOutage` holds → `health` when the spec has
    a `health` URL, else `until` now + `cooldown.outage` (5 min);
  - `AuthenticationError` → `run`;
  - anything else → none (quality failures never exclude).
- `makeRoster({ executors, state?, probe?, events, now? })` →
  `RosterShape`:
  - `lease(role, { avoid?, prefer?, label? })`: scoped; picks the eligible
    executor (has the role, not excluded, not in `avoid`, a free slot for
    the role) by priority, then least recently leased; the preferred one
    wins only while it ranks with the best free one. Waits while none is free, waking on every release, every
    exclusion change, the earliest `until`, and every 15 s for `health`
    probes. Fails `RosterExhausted { role, reasons }` when no executor with
    the role exists or every one is excluded for the run. Returns
    `Lease { executor, release }` (`release` idempotent and also a scope
    finalizer).
  - `tryLease(role, options)`: the same, returning `undefined` instead of
    waiting (used for the borrow decision).
  - `canEverServe(role, avoid)`: some executor outside `avoid` has the role
    and is not excluded for the run.
  - `available(role)`: free slots for the role across non-excluded
    executors.
  - `slots(role)`: configured slots for the role.
  - `exclude(id, exclusion)`, `pause(id, until?)`, `resume(id)`,
    `report(executorId, error)` (classifies and excludes), `snapshot`.
  - Every lease, release, exclusion and return is published as an `Info`
    event prefixed `roster:`.
- `RosterStateStore`: load/merge/save of the state document through
  `PlainFileStore`, dropping expired entries; saves re-read the file first so
  concurrent runs merge rather than overwrite.

### `packages/flow/src/RosterSeats.ts`

Seats over a roster, given `seatFor(executor, role, workDir)` from the
runner:

- `rosterSeat(roster, source, role, workDir, { avoid, borrow })`: an
  `LlmServiceShape` whose every call leases a slot for `role` (avoiding the
  given executors), runs on that executor's seat, reports failures to the
  roster, and releases. When `avoid` leaves nobody who can ever serve, it
  borrows the `borrow` executor and publishes `roster: … not independent`.
- `makeHeldCoder(roster, source, workDir, { eager, prefer, label })`: an
  `LlmServiceShape` over one held coder lease. A failure that excludes its
  executor triggers a handover (release, lease another coder avoiding the
  excluded one, repeat the call with a takeover note), at most twice; the
  third failure surfaces. Exposes `executor` (current id) and `history`.
- `RosterView` (on `FlowContextShape.roster`): `forRole(role)`,
  `available(role)`, `slots(role)`, `executor` (the context's held coder,
  if any), `history`.

### `packages/core/src/UsageLimits.ts` and the pi, antigravity, copilot connectors

pi, antigravity and copilot failures run through `classifyUsageLimit`
(generic signals, plus pi's provider texts such as "You have hit your
ChatGPT usage limit" and "out of extra usage"), so a usage limit is a typed
`UsageLimitError` for them too.

## Tasks

1. `Role`, `ExecutorSpec`, `RosterDocument`, merge/narrow/violations, with
   tests.
2. `exclusionFor` with tests for every signal and the rate-limit window.
3. `makeRoster`: selection order, slots and `coderSlots`, preferred,
   turns, waiting and waking (`TestClock`), health probing, `RosterExhausted`,
   pause/resume, events.
4. `RosterStateStore`: load, expiry, merge-on-save.
5. `rosterSeat` and `heldCoder`: per-call leasing, avoidance, borrowing,
   handover with the takeover note, the handover cap.
6. Usage-limit classification for pi, antigravity, copilot.

## Non-goals

- Matching stories to executor tiers (a later `needs`/`tier` pair).
- Shared capacity across executors on one server.
- Cost- or quota-aware scheduling.
