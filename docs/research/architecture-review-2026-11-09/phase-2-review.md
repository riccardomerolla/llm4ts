# Phase 2 review: what 4.0.0 should carry

Written 2026-11-13, after phase 1 shipped. It re-reads units 8 to 12 of
[proposal.md](proposal.md) against `main` at 3.4.0 and is the starting point
for a session with no memory of the work so far.

## Where phase 1 ended

| Unit     | Shipped in | Result                                                                                                                                                                       |
| -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | 3.2.6      | `--verbose` reaches flows; one `resolveSeat`; `on` accepted                                                                                                                  |
| (config) | 3.3.0      | Settings registry, `config.env` files, `llm4ts config`, trust list (ADR 0049). Not in the proposal; it replaced the planned `RunConfig`                                      |
| 2 to 7   | 3.4.0      | Cleanup; no import cycles; `hub.consume`/`hub.drained`; `eventLanes`/`eventPresentation`; `connectorTable`; checked seat readers; every `LLM4TS_*` read through the registry |

Three rules are now enforced by a check, which changes what phase 2 can rely
on: an event without a table entry does not compile, a connector without a
factory or preset does not compile, and a raw `LLM4TS_*` read fails
`examples/test/settings-sync.test.ts`. `pnpm unused` fails on an unused
module and on an import cycle.

## The units, re-read

Measured on `main` at 3.4.0 unless a line says otherwise.

### Unit 8: delete dead code

| Candidate                                                          | Lines                       | State                                                                                                               | Needs a decision                                               |
| ------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `core/providers/ClaudeAgentSession.ts` with `core/AgentSession.ts` | 232 + 69                    | allowlisted in `scripts/unused-modules.mjs` as "session seam for delegation (ADR 0035)"; ADR 0035 is still Proposed | yes                                                            |
| `flow/Mermaid.ts`                                                  | 112                         | allowlisted, "kept by decision (3.0.0 cleanup)"                                                                     | yes                                                            |
| `runner/McpStdio.ts`                                               | 41                          | allowlisted, same reason                                                                                            | yes                                                            |
| `flow/Classified.ts`                                               | 72                          | allowlisted, "the judgment log's redaction contract"; nothing imports it                                            | yes                                                            |
| `flow/BasecampTool.ts`                                             | 581                         | allowlisted, "consumed by sibling projects"                                                                         | keep: the session memory records a sibling project built on it |
| `"OpenCode"` in `LlmProvider`                                      | 3 sites in `core/Models.ts` | still there; the `connectorTable` row carries it                                                                    | no, it is residue                                              |
| `coderFromEnv`                                                     | `runner/Connectors.ts:309`  | deprecated in 3.4.0                                                                                                 | no                                                             |
| `awaitConsumed`                                                    | `flow/FlowEvents.ts:1047`   | deprecated in 3.4.0                                                                                                 | no                                                             |

New since the proposal: phase 1 added the two deprecations and three thin
wrappers kept only for compatibility (`reasonerFromEnvironment` and
`storyCoderFromEnvironment` in `flows/lib/epic-stories.ts`, the runner's
`coderFromEnvironment` kept as the single-seat reader, which stays).

### Unit 9: one fingerprint, no pass-through re-exports

Three fingerprint functions exist: `fingerprintOf` (`flow/ReviewCache.ts:9`),
`reviewFingerprint` (`runner/ReviewFingerprint.ts:3`, 13 lines) and
`judgmentFingerprint` (`flow/Judgment.ts:361`). The proposal merges the first
two and accepts one cold review cache for in-flight modernization estates.
`judgmentFingerprint` keys a different cache and was not in the proposal;
check before touching it.

The four re-exports the proposal named are unchanged: `Flow.ts:58`,
`Gates.ts:15` (the only `export *` in the packages), `Pack.ts:13`,
`Taskforce.ts:15`. Phase 1 added three more to avoid breaking a 3.x minor,
and they belong on the same list: `Survey.ts` re-exports `JoinMatch` (now in
`GraphRules.ts`), `eval/Evaluator.ts` re-exports the `Evaluator` type (now in
`eval/Eval.ts`), and `Terminal.ts` re-exports `Verbosity` (now in
`EventPresentation.ts`).

### Unit 10: surface gate

Subpath exports today: core 58, flow 108, runner 40, js 3, shell 21, which is 230. The proposal counted 219 and aimed for 180. Phase 1 and the config work
added eleven, among them `flow/Settings`, `runner/EventPresentation` and
four shell modules (`Config`, `ConfigCommand`, `ConfigEdit`, `ConfigTrust`).
The shell's 21 are the clearest case: nothing outside the shell should import
them, and the proposal reduces the shell to its bin.

The mechanism proposed is a first-line `// @internal: <reason>` marker, with
`scripts/unused-modules.mjs` deriving every `exports` map and failing on an
outside import of an internal module. That script already walks imports and
resolves subpaths, so the derivation is an extension of it, not a new tool.

This unit splits cleanly: the marker and a check that only reports can land
in 3.x; removing the subpaths is the break.

### Unit 11: offline readers move from runner to shell

`Profile` (1196), `Watch` (446), `RunReaders` (370), `StoryReaders` (157) and
`Costs` (148) total 2317 lines. Every importer outside the group is in
`packages/shell/src`, so the move is mechanical. They read
`runner/EventPresentation`, which stays in the runner because the terminal
uses it; the shell already depends on the runner. The break is the five
`@llm4ts/runner/*` subpaths disappearing.

### Unit 12: unreadable environment values fail

ADR 0049 already says a bad environment value warns in 3.x and fails in
4.0.0. After phase 1 this is one place: `launchProblems` in
`packages/shell/src/Config.ts` decides severity. Two things the proposal did
not have to consider:

- A flow started without the shell (`node flows/x.ts`,
  `pnpm --filter @llm4ts/flows …`) never passes that check. Its readers use
  `settingValue`, which treats unreadable as unset. Either that path stays
  lenient, or `settingValue` gains a strict mode the runner turns on.
- 3.4.0 already made unreadable values behave as unset everywhere, so 4.0.0
  turns "silently the default" into "refused", which is the stricter and
  safer direction.

## Carried over from phase 1

Not in the proposal's phase 2, found while building phase 1:

1. **Model and flag settings apply in few flows.** `LLM4TS_CODER_MODEL` and
   `LLM4TS_REASONING_MODEL` are honoured by the epic flows, `local` and
   `sdd`; `LLM4TS_CODER_FLAGS` and `LLM4TS_REASONING_FLAGS` by the epic flows
   only. Sixteen flow families ignore all four, so
   `config set LLM4TS_CODER_MODEL=…` does nothing for `implement`. Widening
   is additive and fits a 3.x minor, through `seatsFromEnvironment`.
2. **Lists the connector table showed to disagree.** The flow help names
   three credential variables and `doctor` four. `JsProvider` accepts 7
   provider names and `apiPresetFor` 11. `providerForConnector` defaulted
   `gemini-cli` and `opencode` to OpenAI. Each kept its value in 3.4.0.
   Aligning them is a small 3.x fix each, or a 4.0.0 line item if the
   alignment narrows anything.
3. **`copilot` is a connector that cannot be chosen as a coder** (its table
   row has no names). The proposal's open question 6, still open.
4. **Three files still read settings by hand**, outside the ratchet's areas:
   `kits/j2ee-nextjs/fixtures/demo-bank/preflight.mjs`,
   `tools/judgment/lib.ts`, `examples/gemini-acp-bridge-smoke.ts`.

## Decisions that block work

Each has a recommendation; none can be settled from the repository.

| #   | Question                                                                       | Recommendation                                                                                  | Blocks       |
| --- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------ |
| 1   | Delete `Mermaid` and `McpStdio`? 3.0.0 kept both by decision                   | Delete unless a sibling project imports them: 153 lines with no importer here                   | unit 8       |
| 2   | Delete `ClaudeAgentSession` and `AgentSession` while ADR 0035 is Proposed?     | Decide ADR 0035 first. If delegation is not planned for 4.x, delete and mark the ADR superseded | unit 8       |
| 3   | Is `Classified` a contract callers should use?                                 | If nothing will adopt it in 4.0.0, delete it with its `Declassified` event                      | unit 8       |
| 4   | Which `@llm4ts/flow` and `@llm4ts/runner` subpaths do sibling projects import? | List them from the sibling repositories before unit 10; that list is the public surface         | units 10, 11 |
| 5   | Is one cold review cache acceptable for estates mid-modernization?             | Yes, stated in the changelog                                                                    | unit 9       |
| 6   | Should a flow started without the shell refuse an unreadable value?            | Yes, through a strict mode the runner enables, so both launch paths agree                       | unit 12      |

### Answered 2026-11-13

The owner accepted every recommendation above. Question 4 was answered by
reading `nightcall` (acd7d95, pins 2.45.0) and `dunder-mifflin` (1b5af99,
pins 0.10.1).

| #   | Answer                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Delete `Mermaid` and `McpStdio`: neither sibling imports them                                                                          |
| 2   | Delete `AgentSession` and `ClaudeAgentSession`: delegation is not planned for 4.x. Unit 8 marks ADR 0035 superseded in the same change |
| 3   | Delete `Classified` and `Declassified`: neither sibling imports them                                                                   |
| 4   | The sibling surface, below                                                                                                             |
| 5   | Yes, one cold review cache, stated in the changelog                                                                                    |
| 6   | Yes, a strict mode the runner enables                                                                                                  |

Subpaths the siblings import, which unit 10 must keep public:

- `@llm4ts/core`: `ConnectorConfig`, `ProcessExecutor`, `Models`, and the
  root entry.
- `@llm4ts/flow`: `GitHubTool`, `BasecampTool`, `FlowEvents`, `FlowError`,
  `CostLedger`, `CostTracker`, `Plan`, `FlowContext`, `Chat`, `Review`,
  `Planner`, `Persistence`, `Flow`, and the root entry.
- `@llm4ts/runner`: `Terminal` (`parseVerbosity`, `makePlainTerminalSurface`),
  `NodeProcessExecutor`, `FlowRunner`, `NodePlainFileStore`, `Connectors`
  (`coderFromEnv`, `withTurnLimit`), and the root entry.

No sibling imports a unit 11 reader, so the move to shell breaks nothing
outside this repository. One 4.0.0 removal does reach a sibling: `nightcall`
calls `coderFromEnv` in `src/Engineer.ts` and `src/Stages.ts`. The migration
note must name `coderFromEnvironment` as its replacement, and `nightcall`
needs that change before it moves to 4.x.

## Suggested order

Subtract first, then gate what is left.

1. **3.5.0, additive, optional.** Widen the model and flag settings (carried
   item 1). Align the disagreeing lists where that widens (item 2). Land the
   `@internal` marker and a report-only exports check (unit 10, first half).
   Convert the three remaining hand reads (item 4).
2. **Decisions 1 to 6**, with question 4 answered from the sibling
   repositories.
3. **4.0.0**, one release carrying every break, in this order: unit 8
   (deletions and the two deprecated functions), unit 9 (fingerprint and the
   seven re-exports), unit 11 (readers to shell), unit 10 second half
   (derived exports, shell reduced to its bin), unit 12 (strict environment).
   Each unit passes the chain on its own; the pack smoke gains an assertion
   that an internal subpath fails to import.

A migration note for 4.0.0 should list, for each removed subpath and
function, what replaces it.

## Not verified here

- Importer counts for the allowlisted modules come from the allowlist in
  `scripts/unused-modules.mjs`, which `pnpm unused` enforces. No sibling
  repository was read.
- The line counts and export counts were measured on `main` at 3.4.0.
- Nothing in this page was built.

## Phase 3, unit 15: dropped (2026-11-13)

The shared run-state fold already exists: `reduceTree` in
`packages/runner/src/AgentTree.ts` feeds the live dashboard
(`AgentTreeSurface`), `llm4ts watch`, the run summary and the operator's run
readers. Only `Terminal` and `Profile` fold on their own. Their overlap with
the tree is about 20 lines of lane lifecycle in `Profile`. `Terminal` counts
tokens differently (input and output, in flight, estimated), reads the clock
rather than the event, and opens a lane on any laned event, so moving it onto
the tree would change what it prints. Golden tests over three traces now pin
what each run view prints (`RunViews.golden.test.ts` in runner and shell).

## Phase 3, unit 14: the smaller deepening (2026-11-13)

The plain path did not become a roster of one. That would add
`context.roster`, which the epic and taskforce flows branch on, rename the
trace labels, merge reviewers into one seat and force them read-only.
Instead, both builders offer every seat through one local `decorated` in
`FlowRunner.ts` (timing and transcript). Seat resolution was already shared
through `resolveSeat` since unit 2, and the `deniedPaths` drift was gone.
Two drifts were fixed: a roster run did not time or transcribe the flow's
own judgment seat, and the Gemini bridge started for the flow's seats rather
than the roster's. `SeatParity.test.ts` pins both paths, with the intended
differences named; `FlowRunner.test.ts` is unchanged.
