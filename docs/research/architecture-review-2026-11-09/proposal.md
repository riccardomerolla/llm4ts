# Architecture review: proposal

Date: 2026-11-09, at commit `894506cd` (packages 3.2.5). Status: a proposal.
Nothing here is decided or implemented, and no ADR has been written.

How it was made: three read-only explorers grounded the review, two runners
wrote competing proposals from that grounding ([candidate 1](candidate-1.md),
subtract in place; [candidate 2](candidate-2.md), redraw the boundaries), an
independent judge scored both, and this file is the synthesis. Numbers are
measured unless marked estimate.

## Problem

The package graph `core → flow → runner → js/shell` is sound: no package
imports against it. The cost sits inside the packages, as the same fact
written in several places.

- **Connector identity** is hand-copied in about fourteen places across core,
  runner, shell and js.
- **Event handling** has five copies of the consumer loop and eight separate
  switches over event tags, which have already drifted.
- **Run configuration** is read from the environment in 88 files, with five
  boolean parsers and at least sixteen ad hoc integer parses.
- **Every module is public.** The exports maps mirror `src`: 219 subpaths, of
  which about 40 serve no caller outside their own package. An allowlist keeps
  seven modules that nothing imports.
- **`@llm4ts/flow` is two things**: a kernel of 59 modules (17,951 lines) and
  product code (modernization, taskforce, roundtable, tools) of 48 modules.
  The orchestration loops of the large flows live in `flows/lib`, outside any
  package.

The drift has reached users. These are defects today:

| Defect                                                   | Evidence                                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm4ts run --verbose` has no effect on a flow           | the shell sets `LLM4TS_VERBOSITY` (`packages/shell/src/Cli.ts:208`); `runWithBundle` uses `options.verbosity ?? "Normal"` (`packages/runner/src/FlowRunner.ts:1010`) |
| The roster judgment seat ignores the run's `deniedPaths` | `FlowRunner.ts:886` omitted the argument, so that seat always got the default `.llm4ts/**`; a run passing `[]` (port-guide) was not honoured there. Fixed in unit 1  |
| `LLM4TS_GEMINI_BRIDGE=on` is ignored                     | `truthy` at `FlowRunner.ts:266` accepts `1`, `true`, `yes` only; other parsers accept `on`                                                                           |
| An unknown `LLM4TS_CODER` silently runs claude           | `coderFromEnv` (`packages/runner/src/Connectors.ts:268`), used by 21 flow scripts                                                                                    |
| `llm4ts profile` shows no roundtable or taskforce lanes  | `Profile.ts:207` parses only `story` stages; `AgentTree.ts:283` parses all three                                                                                     |
| About half the `LLM4TS_*` variables are undocumented     | 105 names in production code, 53 in `docs/configuration.md`                                                                                                          |
| The authoring skill points at code nobody can import     | `skills/authoring-llm4ts-flows/SKILL.md:20` says to build on `runEpicStories`, which no package exports                                                              |
| A flow edit is invisible to the local CLI until a build  | built-ins run from `packages/shell/flows/*.js`, transpiled by `scripts/sync-shell-flows.mjs`                                                                         |

## Synthesis decision

**Base: candidate 1.** The judge and the orchestrator picked it independently.
It fixes the defects first, removes duplication at its owner, and keeps the
breaking release small. Judge scores, candidate 1 against candidate 2:
grounding 5/4, net subtraction 4/2, interface depth 4/4, sequencing 5/3, risk
and consumer impact 4/2, fit with repo rules 5/3.

**Changed from candidate 1 in synthesis:**

1. **Reordered so most of the value ships without a major.** Candidate 1 put
   every consolidation behind 4.0.0. Most of its owners are additive, so they
   move to 3.x minors, and 4.0.0 carries removals only.
2. **`hub.consume` does not seed its counter from the published count.**
   Seeding makes a late subscriber look drained while it has missed events.
   That is the bug fixed in 3.2.5, where the terminal and the trace lost the
   startup capability warnings. A consumer that subscribes late is named by
   `hub.drained()` instead.
3. **`envString` is dropped.** It forwards `environment[name]` and hides
   nothing.
4. **`Classified` is not deleted without a decision.** No production code
   imports it, but `JudgmentLog.ts` documents a redaction contract around
   sealed values. See the open questions.

**Grafted from candidate 2:**

1. **The fork gap is real and candidate 1 missed it.** The loops
   `runEpicStories`, `runTaskforce` and `runRoundtable` import runner, so they
   cannot move into flow. A package above runner that holds `flows/` is the
   one structural move worth making. It is deferred to phase 3 and gated on an
   ADR, because it is additive and can follow the subtraction.
2. **Offline readers move from runner to shell in 4.0.0.** Profile, Watch,
   RunReaders, StoryReaders and Costs (about 2,400 lines) are imported only by
   the shell. Moving them with the other breaks makes "the runner stays thin"
   closer to true.
3. **Frozen documents move to `docs/history/`**, and the exports check fails
   on `export *`.

**Rejected:**

- **A sixth package now, and moving 34k lines across about 400 files.** The
  total does not shrink, and it would break nearly every subpath days after
  3.0.0.
- **`flowMain` beside `runNode` and `runFlowMain`.** It would be a third way
  to start a flow.
- **A resolve-time redirect for old import paths.** It is a hidden second way
  to import the same thing.

## Shape

Five owners, each in the package that already holds the knowledge. Type
sketches for all five are in [candidate 1](candidate-1.md), under "Type and
signature sketches".

1. **Connector identity: one `connectorTable` in `core/src/Models.ts`.** Ids,
   aliases, base URLs, credential variables and executables are derived from
   it. Factories and presets become exhaustive records, so a connector missing
   a factory is a type error.
2. **Seats: `seatsFromEnvironment` in `runner/src/Connectors.ts`.** One
   checked reading of the coder and reasoner variables replaces
   `coderFromEnv` and the private copies in `flows/lib/epic-stories.ts`.
   Inside the runner one `seat(config, workDir)` serves all six sites.
3. **Run configuration: `RunConfig` in runner.** The shell encodes it and the
   runner decodes it with the same schema, so a flag cannot be set on one side
   and ignored on the other. `envFlag` and `envInt` give flow-level knobs one
   grammar. A docs test fails when a variable in code is missing from
   `docs/configuration.md`.
4. **Events: `hub.consume` and `hub.drained` in `flow/src/FlowEvents.ts`**,
   plus two exhaustive tables keyed by event tag: lanes in flow, screen policy
   in runner. A new event does not compile until both tables classify it.
5. **Public surface: `pnpm unused`, deepened.** A module marked
   `// @internal: <reason>` is not exported. The script derives the exports
   maps and fails on drift, on an outside import of an internal module, on an
   import cycle, on `export *`, and on a module that is only transitively
   alive.

## Work plan

Every unit runs `pnpm typecheck`, `lint`, `format:check`, `unused` and `test`.
Units that change CLI behaviour are also driven through the `verify-llm4ts`
skill. Units that touch exports also run `pnpm build && node
scripts/pack-smoke.mjs`.

### Phase 1: fixes and additive owners (3.2.x and 3.x minors, no breaks)

| #   | Unit                                                                                                                                  | Proof                                                                   | Release                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| 1   | `--verbose` reaches the flow; one `seat()` for all six sites; `truthy` accepts `on`                                                   | new FlowRunner tests; `verify-llm4ts` run with `--verbose`              | patch                          |
| 2   | Repo cleanup (list below)                                                                                                             | docs-sync tests, `pnpm unused`                                          | none                           |
| 3   | Break the three import cycles: finish the `ReviewModel` split, move `JoinMatch` into `GraphRules`, the eval type                      | a cycle check added to `pnpm unused` reports 0                          | patch                          |
| 4   | `hub.consume` and `hub.drained`; five loops and the manual drain go                                                                   | consumer tests; a late-subscriber test that names the laggard           | minor                          |
| 5   | `eventLanes` and `eventPresentation`; eight switches go                                                                               | renderer tests unchanged; `profile` shows attendee and specialist lanes | minor                          |
| 6   | `connectorTable` with derived lists                                                                                                   | factory, preset and `CoderChoice` tests; a type test per row            | minor                          |
| 7   | `seatsFromEnvironment`, `envFlag`, `envInt`, `RunConfig`; flows migrate; `coderFromEnv` deprecated; `docs/configuration.md` completed | Connectors, FlowRunner and shell tests; docs test                       | minor, ADR "run configuration" |

### Phase 2: 4.0.0, the release that carries the breaks

| #   | Unit                                                                                                                                              | Proof                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 8   | Delete dead code: `ClaudeAgentSession` with `AgentSession`, the `OpenCode` provider residue, and, if decided, `Mermaid`, `McpStdio`, `Classified` | `pnpm unused` with the allowlist reduced                                                    |
| 9   | One fingerprint; pass-through re-exports removed (`Flow.ts:58`, `Gates.ts:15`, `Pack.ts:13`, `Taskforce.ts:15`)                                   | typecheck, flow tests; changelog notes one cold review cache                                |
| 10  | Surface gate: `@internal` on about 18 modules, derived exports, shell exports reduced to the bin                                                  | `pnpm unused`, pack smoke asserts an internal subpath fails to import. ADR "public surface" |
| 11  | Offline readers move from runner to shell                                                                                                         | lint rule: runner imports nothing from shell                                                |
| 12  | Remove `coderFromEnv`; malformed environment values fail with a typed error                                                                       | flow smokes                                                                                 |

### Phase 3: decisions after 4.0.0

| #   | Unit                                                                                                                                                   | Gate                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 13  | A package above runner that holds `flows/` as modules with thin scripts, exports the three loops, and replaces the flow half of `sync-shell-flows.mjs` | ADR amending 0006 and 0014     |
| 14  | One context builder: a plain run is a roster of one executor per seat                                                                                  | FlowRunner tests unchanged     |
| 15  | One run-state fold shared by Terminal, AgentTree and Profile (estimate 400 to 700 lines)                                                               | golden traces before and after |

## Repo cleanup

Evidence for each row is in the candidates' cleanup tables.

| Item                                                                                             | Action                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `docs/superpowers/plans/` (14 files, about 0.9 MB, the largest tracked file is here)             | delete; no inbound reference. Keep `docs/superpowers/specs/`, which ADRs link                                                    |
| `tools/loop/` (8 files, pinned to 0.1.x)                                                         | delete; ralph is the documented loop                                                                                             |
| `tools/prototype/watch-tui.ts`                                                                   | delete                                                                                                                           |
| `specs/architecture/overview.md`                                                                 | delete and point the Ralph prompt at `CLAUDE.md`; it sends agents to `docs/csp/` and `docs/parity.md`, which `CLAUDE.md` forbids |
| `plan.md`, `docs/csp/`, `docs/CSP_STATUS.md`, `docs/parity.md`, `docs/migration-from-llm4zio.md` | move to `docs/history/`; fix the README links and the `CLAUDE.md` paths                                                          |
| `docs/presentation/marvin-gen.py`                                                                | move out of the published folder; it hardcodes a local path and `pages.yml` publishes the whole directory                        |
| `.env.example:7,34`                                                                              | fix the path to `examples/api-provider.ts`                                                                                       |
| `flows/package.json` scripts                                                                     | add the four missing flows and a test that every `flows/*.ts` has one                                                            |
| `scripts/set-version.mjs:17`, `scripts/pack-smoke.mjs:14`                                        | derive the package list from `packages/*`                                                                                        |
| `package.json`                                                                                   | pin `@effect/language-service`; declare `tsx` or stop using it                                                                   |
| `packages/shell`                                                                                 | add README and LICENSE, as the other four packages have                                                                          |
| `packages/js/package.json`                                                                       | drop the unused `@llm4ts/flow` dependency                                                                                        |
| `examples/test/skills-sync.test.ts:48`; the Ralph verification chain                             | cover all five skills; add `pnpm unused`                                                                                         |
| `scripts/unused-modules.mjs`                                                                     | skip the build copies under `packages/shell/{flows,kits}`                                                                        |
| `specs/pending` rehearsal specs (six or seven)                                                   | the owner's call: they are not loop work                                                                                         |
| Local and untracked: `repos/` (84 MB), four merged `.claude/worktrees/*`, `flows/dist/`          | delete locally                                                                                                                   |

## Tradeoffs accepted

- We accept a 4.0.0 soon after 3.0.0 in exchange for carrying every removal
  once. Phase 1 needs no major, so 4.0.0 can wait for a convenient window.
- We accept one cold review cache for the modernize and convert flows in
  exchange for one fingerprint function.
- We accept a marker comment for internal modules, backed by a failing check,
  in exchange for an unchanged directory layout.
- We accept two event tables in exchange for keeping screen policy out of
  flow. Both are exhaustive over the event tags.
- We accept that `@llm4ts/flow` stays one package of 107 modules through
  phase 2. Phase 3 is where its product code would get a home.

## Open questions

1. Delete `Mermaid` and `McpStdio` in 4.0.0? 3.0.0 kept both by decision.
2. Delete `ClaudeAgentSession` while ADR 0035 is still Proposed?
3. Is `Classified` a contract you intend callers to use? Nothing imports it
   today.
4. Does a sibling project import `@llm4ts/flow/BasecampTool`, or more than
   that? This repository cannot tell.
5. Is one re-review of in-flight modernization estates acceptable when the
   fingerprints merge?
6. `copilot` is a connector but cannot be chosen as a coder. Intended?
7. `pages.yml` publishes all of `docs/presentation/`, the internal pitch decks
   included. Intended?
8. Should phase 3 unit 13 happen at all, and if so under which package name?

## Next implementation step

Unit 1: make `runWithBundle` fall back to `LLM4TS_VERBOSITY`, route the six
seat resolutions through one `seat(config, workDir)`, and accept `on` in
`truthy`, each with a FlowRunner test, released as 3.2.6.
