# Changelog

## Unreleased

- Internet-banking portal fixture on `effect@4.0.0-rc.115`, the engine's
  own pin, with no source change: the kit's HttpApi contracts, the fake
  transport, and the hooks compile and pass their gates unchanged. Install
  it with `pnpm install --ignore-workspace` (and `pnpm add … --ignore-workspace`):
  the fixture's `.npmrc` alone does not stop `pnpm add` from writing the
  workspace's lockfile.

## 2.0.0

### Breaking

Four cleanups the 1.x contract could not carry. Each has a one-line
migration.

- `LLM4ZIO_CODER` is no longer read; `LLM4TS_CODER` is the only coder
  selector. Migration: rename the variable.
- `LLM4TS_JUDGE_SOURCES_LIMIT` is no longer read; `LLM4TS_CONTEXT_BUDGET`
  is the only context budget. Migration: rename the variable.
- The pack manifest field `programFiles:` is now `program-files:`, matching
  the other multi-word header fields (`specs-dir`, `features-dir`,
  `spec-schema`). A manifest with the old spelling fails to load with the
  rename spelled out. Migration: rename the field; the value is unchanged.
  The `Pack.programFiles` property in TypeScript keeps its name.
- A page spec's `apiCalls[].esbService` must be an identifier
  (`ESB_ACCT_LIST`); a spec that carries prose there no longer decodes.
  Found in the second rehearsal, where the analyst wrote its uncertainty
  into the field and the contract published it as the service name.
  Migration: omit the field when the service is unknown; the prompt now
  says so.

- Effect moves from `4.0.0-beta.102` to `4.0.0-rc.115` (`effect`,
  `@effect/platform-node`, `@effect/platform-node-shared`, `@effect/vitest`,
  all pinned exactly). Exported types now come from the release-candidate
  line; a consumer's own `effect` must match. Inside, the beta's
  `Schema.TaggedErrorClass` is the RC's `Schema.TaggedError`, the CLI
  constructors are capitalised (`Argument.String`, `Flag.Boolean`,
  `Prompt.Select`), and `SchemaError` lives in `effect/Schema` — none of
  which is llm4ts API, but anyone extending its error classes sees the
  rename. Migration: `npm i effect@4.0.0-rc.115` (or `effect@rc`).

Nothing else changed: the subpath exports, the runner barrel, the flow and
kit layouts, the three discovery tiers, and the remaining `LLM4TS_*`
variables are as in 1.0.0.

## 1.0.0

No code changes over 0.18.1. This release declares the public surface
stable, now that it has been exercised by a live rehearsal without needing
to change:

- **Package subpath exports** of `@llm4ts/core`, `@llm4ts/flow`,
  `@llm4ts/runner`, `@llm4ts/shell`, and `@llm4ts/js`, plus the
  `@llm4ts/runner` root barrel for flow authors. Importing package-private
  files remains unsupported.
- **Flows**: one TypeScript file, the first `//` line its description,
  discovered in the project (`.llm4ts/flows/`), global
  (`~/.config/llm4ts/flows/`), and built-in tiers with that precedence, run
  by `llm4ts run` with `--repo`, `--pack`, and `--verbose`, resumable from
  `.llm4ts/` in the target repository.
- **Kits** (ADR 0014): the directory layout `packs/`, `scaffolds/`,
  `patterns/`, `flows/`, `fixtures/`, `README.md`, discovered in the same
  three tiers, and pack selection by bare name, `kit/pack`, or a directory
  holding `pack.md`.
- **Pack manifests**: the header fields and sections documented in
  `kits/README.md` and the guide, including `spec-schema`.
- **Environment**: the `LLM4TS_*` variables listed in
  `docs/configuration.md`; secrets never appear in arguments, logs,
  traces, or errors.

Behaviour of the modernization and conversion flows keeps evolving with
the rehearsals; those changes stay additive within 1.x. The pinned
reference is llm4zio v4.3.0.

## 0.18.1

- A wave-scoped extraction (`LLM4TS_WAVE`) can now clear its gate: the
  coverage check gates only units captured from the wave's own program
  files and reports the others as belonging to later waves, with a closing
  run without `LLM4TS_WAVE` enforcing estate-wide coverage. Before, every
  wave but the last failed on units it could not cover and burned its three
  fix rounds on them — found in the first live rehearsal of the workshop
  runbook. `SpecChecks` gained `capturedUnits` (units with their source
  files) and `coverageReport` (the gated result plus the out-of-scope list);
  `coverage` accepts an `inScope` option.
- Packs can declare `spec-schema: pagespec` (the `j2ee-nextjs-spa` pack does):
  the extraction gate then decodes every program spec's ```json pagespec
block by code, before the judge, and reports an undecodable one as a
per-program Critical finding the fix turn repairs. Found in the same
rehearsal, where a spec written by an estate-wide fix round carried a
prose `apiCalls`entry and`convert-page` was the first to reject it. The
finding states the exact block shape (`pageSpecShapeHint`), which turned
  two failed fix rounds into one that passed.
- A page spec's API call can now return one of the page's DTOs, or a list
  of it: `apiCalls[].responseDto` names a `dtos` entry by domain name and
  `responseShape` is `single` or `list`. `openApiFor` emits the DTO as a
  shared component and wraps a list in an array schema, and contract paths
  are always rooted. Found in the rehearsal's Act 2: with only flat field
  mappings the contract turned `accts[].curBal` into a scalar and the
  converter built a single-balance page the judge rejected.
- `openApiFor` emits one operation per method under a path: calls sharing
  a method and path (a page load and its JSON refresh on the same GET)
  collapse into the first, whose description names the variants, instead
  of a duplicate YAML key.

## 0.18.0

### Breaking

- Packs, scaffolds, and pattern cards moved out of `flows/` into two
  **kits** under `kits/` (ADR 0014): `mainframe-java` (COBOL/JCL and ACE
  packs, Spring Boot and Kafka Streams scaffolds, the COBOL pattern deck)
  and `j2ee-nextjs` (JSP packs, Next.js and Spring BFF scaffolds, the
  `convert-page`/`convert-all` flows, the demo-bank fixture). `LLM4TS_PACK`
  now takes a bare pack name (`cobol-springboot`, the default), `kit/pack`,
  or a directory holding `pack.md`; the old `packs/<name>` relative form
  only resolves when such a directory exists under the launch directory.
  `@llm4ts/runner/Packs` lost `loadUniversalPatternCards` (use
  `loadKitPatternCards(opened)`) and `locatePack` takes the discovered kits
  instead of root directories. `node_modules/@llm4ts/shell/flows/packs` no
  longer exists; the shipped kits are at `node_modules/@llm4ts/shell/kits`.

- `@llm4ts/modernize` is retired. `Approval` and `Artifacts` moved to
  `@llm4ts/flow/Approval` and `@llm4ts/flow/Artifacts` unchanged; the
  `Modernize`/`Model` state machine, which no flow ever called, is removed
  (`docs/parity.md` records the divergence: phases run as resumable scripts
  over artifact checkpoints and markdown approval gates). The npm package is
  deprecated in favour of `@llm4ts/flow`.

### Changed

- The autonomous loop moved to `tools/ralph/` (`ralph-auto.sh`,
  `RALPH_AUTO_PROMPT.md`); its progress file is no longer tracked.
  `examples/` keeps the embedding scripts and starters; the demo-bank
  fixture lives with its kit.

### Added

- `@llm4ts/runner` gained a root export, the flow author's barrel: the
  runner and flow verbs a flow script uses (`runNode`, `runFlowMain`,
  `resolveFlowInput`, `coderFromEnv`, `apiConnectorFromEnvironment`,
  `openPack`, `completeAndPublish`, `implementPlanFlow`, `stage`,
  `implementTaskLoop`, `reviewAndFixLoop`, `lintCommand`, `makePlanStore`,
  `planFrom`, `defaultPlanPath`, events, errors) re-exported so a script
  needs one import line. Re-exports only; the subpaths stay the contract.
  Every shipped flow now imports from it.
- A built-in `hello` flow: one prompt to the configured provider, mock by
  default, so `npx -y @llm4ts/shell run hello` is a zero-setup first run and
  `llm4ts view hello` is the template a project flow starts from. The
  README, the guide's chapter 3, and the flow-authoring skill all carry
  that file verbatim, pinned by the sync tests.
- The README is chapter zero of the guide: try it, do real work, write a
  flow, fork a built-in, kits, embed it — each the first screen of a
  chapter — followed by the packages, configuration, and reference links.
- Kit discovery in `@llm4ts/runner/Kits` across the project
  (`.llm4ts/kits/`), global (`~/.config/llm4ts/kits/`), and built-in tiers,
  with project > global > builtin shadowing by kit name and an error naming
  the candidates when two kits of one tier ship the same pack.
- `llm4ts kits` lists the discovered kits with their packs and flows;
  `llm4ts run --pack <ref>` forwards a pack reference as `LLM4TS_PACK`; a
  kit's flows join `llm4ts list` labelled `[<tier> kit:<name>]`.
- Kit READMEs, `kits/README.md`, and ADR 0014 document the layout and the
  resolution rules; the guide, skills, and flows README now point at kits.

## 0.17.0

- Getting started guide under `docs/guide/`: seven one-screen chapters for
  a developer with a coding agent installed — install and `doctor`, run
  `implement` on a throwaway repo, write a zero-install hello flow under
  `.llm4ts/flows/`, fork a built-in with `llm4ts view`, write a
  modernization pack, troubleshoot the five first-run errors — with six
  Mermaid diagrams (the ladder, flow discovery and launch, the implement
  loop, what `runNode` wires, the modernization phases with their human
  gates, and a spec-driven TDD phase over a pack). `docs/flow-authoring.md`
  stays the deep reference the guide hands over to.
- `modernize-pack-check`, the phase before the first paid one: loads a pack
  exactly as survey and extract do, matches `sources:`, `programs:`, and
  every `## Coverage:` and `## Survey:` rule against the estate at `--repo`,
  prints a sample of each rule's units, and lists likely mistakes as
  warnings. No model call; a `sources:` or `programs:` regex that matches
  nothing fails the check.
- Two agent skills beside `using-llm4ts`: `authoring-llm4ts-flows` (write,
  verify offline, and fork a flow) and `authoring-llm4ts-packs` (write a
  pack and check it). Their embedded templates are the same text as guide
  chapters 3 and 5, and `examples/test/skills-sync.test.ts` runs the hello
  template through the shell's resolve fallback against the mock provider
  and loads the pack template with the real loader, so neither can drift
  from the API.

## 0.16.2

- Portal fixture: eslint ignores `.llm4ts/` and any nested `dist/`. The
  epic checkout's `eslint .` walked into the story worktrees under
  `.llm4ts/worktrees/`, each holding a built bundle, and the first story to
  merge in the rehearsal was rolled back by 6975 lint errors that were not
  its own. Any target repository that keeps worktrees under `.llm4ts/`
  needs the same exclusion in tools that walk the tree.
- The committed Conto e Bonifico plan is more precise where the rehearsal
  showed the coder choosing a narrower reading: the Payments contract
  names its three transfer states and what the code `000000` does, the
  create payload lists its fields including a typed beneficiary, and the
  transfer form depends on the Accounts contract it draws source accounts
  from. Two stories had stopped with `BLOCKED_ON` on exactly those gaps.

## 0.16.1

Findings of the first live rehearsal of `epic-stories` (ADR 0013):

- `implementStoriesFlow` gained a `setup` step run in every story worktree
  before its coder — a worktree is a fresh checkout without installed
  dependencies, so the gates could not run there and the coder wandered
  outside its perimeter trying to install them. The flow defaults it to
  `pnpm install --offline` (`LLM4TS_WORKTREE_SETUP` overrides; empty
  disables).
- `LLM4TS_CODER_MODEL` / `LLM4TS_REASONING_MODEL` select the seats' models
  (pi takes `provider/model`), which is how a pi sitting on an exhausted
  free tier is moved to a provider with capacity.
- **Fixed**: a failed `pi -p` completion reported an empty reason. pi
  explains a refusal on stderr (a provider quota, a missing model) and
  prints nothing on stdout; both streams are reported now.
- The shell's `run` command parses its own flags first, so a flow's flags
  go after `--`; the runbook and README say so.
- `BLOCKED_ON:` counts only when the coder's reply ENDS with it: a coder's
  own skills can make it announce a missing reference checkout and then
  carry on, and a story that then completed its tasks was being failed.
  The rules now say tooling, dependencies and reference repositories are
  never a reason to stop.
- The story-plan generator is told that every story owns the test files
  it must write, and the committed Conto e Bonifico plan gives its two
  contract stories a test file each: the judge asks for tests, and a story
  cannot add one outside its owned paths — both contract stories stopped
  with `BLOCKED_ON` for exactly that during the rehearsal.
- Story task loops run with `noopTaskPolicy: "complete"`: a task the coder
  found already satisfied, without replying the exact sentinel, was failing
  the whole story although the story is judged and gated afterwards.
- **Fixed**: pi reports a provider refusal (a usage limit, an auth failure)
  as an assistant message that stopped with an error, on a process that
  exits 0; the stream read it as an empty successful reply, so a whole
  story of tasks "completed" in seconds with no changes once the coder's
  plan ran out. Such a stop is a typed `pi error: …` failure now.
- **Fixed**: `makeLocalBoardSync` lost transitions under concurrent
  mutation — three stories starting at once each loaded the board, changed
  their own item, and the last save won, so the board showed one active
  story out of three. Every mutation now holds one permit.

## 0.16.0

- Parallel story execution (ADR 0013). `@llm4ts/flow/StoryPlan` holds an
  epic's stories with declared dependencies and file ownership, validated
  deterministically (every violation reported at once) and persisted as an
  editable ` ```json storyplan ` block. `@llm4ts/flow/Perimeter`
  fails a story whose branch touched paths outside its `owned` set.
  `@llm4ts/flow/Stories.implementStoriesFlow` runs stories in per-story git
  worktrees under a concurrency cap, each through the unchanged
  `implementPlanFlow`, judges and perimeter-checks the branch, merges it
  into the epic branch one at a time, re-gates the epic head after every
  merge (rolling a red merge back), skips a failed story's dependents
  (`failFast` stops instead), resumes by story-entry hash, treats the
  coder's `BLOCKED_ON:` reply as a typed `MissingDependency`, and writes
  the board and an `EpicReport` whose usage figures are estimates.
- `@llm4ts/flow/GitTool`: `merge` (a conflict fails typed with the
  conflicting paths and aborts), `addWorktreeNewBranch`, `removeWorktree`
  with `force`, `branchExists`, `deleteBranch`, `isAncestor`.
- `@llm4ts/flow/FlowContext`: optional `contextFor(workDir)` — the runner
  rebinds every seat to another directory (a story worktree) while sharing
  the run's events and cost tracker.
- New typed errors: `StoryPlanInvalid`, `PerimeterViolation`,
  `MissingDependency`, `MergeConflict`, `StoryFailed`.
- New flow `epic-stories`: a reasoning seat (`LLM4TS_REASONER`, default
  claude) splits an epic into a story plan, persisted for approval
  (`--plan-only`; an existing file wins over regeneration), then `pi`
  coders (`LLM4TS_CODER`) implement the stories in parallel worktrees under
  `--concurrency` (default 3), each judged and perimeter-checked before its
  merge into `epic/<epic-id>`; `--fail-fast` stops at the first failure.
  The expected split of the demo epic is committed as
  `flows/fixtures/epic-stories/conto-bonifico.md`.
- **Fixed**: the built-in flows shipped inside `@llm4ts/shell` could not
  load `convert-page`, `convert-all` (and now `epic-stories`): they import
  `./lib/<name>.ts`, and `scripts/sync-shell-flows.mjs` copied only the
  top-level scripts. The sync now transpiles `flows/lib/*.ts` beside them
  and rewrites relative `.ts` specifiers to the shipped `.js`.
- **Fixed**: a fresh `npm install` of `@llm4ts/shell` resolved
  `@effect/platform-node-shared` to a newer beta (the transitive range is
  `^4.0.0-beta.102`) whose modules the pinned `effect` beta does not have,
  and npm's peer resolution spun for minutes before failing. The shell now
  pins `@effect/platform-node-shared` at the same exact beta as everything
  else, so consumers resolve the matching version.
- New fixture `examples/internet-banking/portal`: a client-only retail
  internet-banking SPA (Vite, React 19, Effect HttpApi contracts over a
  stateful fake transport, English and Italian, per-feature dictionaries,
  routes and nav with `App.tsx` as the single composition point, Profilo as
  the exemplar feature) — the target of the `epic-stories` demo, with seed
  and smoke scripts and a runbook.

## 0.15.1

- **Fixed**: a structured call whose reply did not decode as the requested
  JSON (`Failed to parse response as structured output: …`) failed the flow
  outright. The retry decorator now re-asks up to `parseRetries` times
  (default 2, independent of the transient and flaky budgets) with the
  parse failure quoted back to the model and an instruction to reply with
  the JSON alone — `repairPrompt` in `@llm4ts/flow/TransientRetry`. Every
  re-ask is the original prompt plus the latest failure, never a repair of a
  repair. A transient or flaky failure inside a structured call still takes
  its own budget and re-sends the same prompt. Streams and tool calls are
  untouched: `isStructuredParseFailure` is a `ParseError`, which only the
  structured entry points raise.

## 0.15.0

- `modernize-extract` extracts and judges the programs of a wave
  concurrently: `LLM4TS_EXTRACT_CONCURRENCY=<n>` (default 1, the previous
  sequential behaviour). The programs are independent — each analyst reads
  only its source and resolved closure and writes only its own four files —
  so this divides wall time without changing tokens, cost, or the bench
  projection. Supporting changes:
  - `extractProgramsResumably` (`@llm4ts/modernize/Artifacts`) takes
    `{ concurrency, onCreated }`: units run under a bounded `Effect.forEach`,
    `onCreated` runs per program once its artifacts are on disk (the seam
    for pattern tagging and the program's commit), and a failure stops new
    programs from starting while the ones in flight finish and land before
    the first failure, in unit order, is re-raised. `programArtifactPaths`
    names a program's four files.
  - `GitTool.commitPaths(message, paths)` stages and commits only the named
    paths (additions, modifications, deletions; an empty list is
    `NothingToCommit`). The per-program commit uses it under one permit, so
    a sibling's half-written artifacts never ride along the way `commitAll`'s
    `git add -A` would sweep them in.
- **Fixed**: a Gemini CLI turn halted by its loop breaker ("A potential
  loop was detected … The request has been halted", or a bare "Loop
  detected") failed the flow outright. The turn is lost, the quota is not,
  and a fresh process with the same prompt ordinarily completes — so the
  retry decorator now classifies it as a flaky stream (the fresh-retry
  budget, six attempts by default; `isFlakyStream` is true, `isTransient`
  false), and the Gemini provider makes sure the reason reaches it:
  `geminiLoopDiagnostic` lifts the stderr line into an anonymous stream
  error the way quota diagnostics already were, and a halted turn that
  still exits 0 with no assistant text fails as a `ProviderError` naming
  the halted turn instead of surfacing as an empty response. The signal
  list lives once, in `@llm4ts/core/providers/CliSupport`
  (`loopDetectionSignals`, `isLoopDetectedMessage`).
- **Fixed**: `GitTool` reported a `Process` error instead of `NothingToCommit`
  when the tree held only untracked files — git says "nothing added to
  commit" there, not "nothing to commit".

## 0.14.0

- **Fixed**: `modernize-survey` reasoned about every estate in COBOL terms.
  The graph-refine and triage prompts were hard-coded in the flow script
  (dynamic `CALL`s, `EXEC PGM=&PGM`, PROC expansions), so a J2EE run under
  `packs/j2ee-nextjs-spa` swapped the regexes but not the instructions.
  `@llm4ts/flow/Survey` now exports `surveyRefinePrompt` /
  `surveyTriagePrompt`: a stack-neutral frame that states the graph's
  provenance from the pack's own `## Survey:` rule names and takes the
  stack-specific paragraph from two new pack sidecars,
  `prompts/survey-refine.md` and `prompts/survey-triage.md`. The COBOL packs
  carry the former wording verbatim; `j2ee-nextjs-spa`, `jsp-nextjs`, and
  `jsp-bff-nextjs` describe web.xml mappings, includes, forwards, redirects,
  form and ajax targets, and how to weigh fragments, servlets, and ESB
  wrappers. A pack without the sidecars gets a neutral default.
- **Fixed**: discovery overflowed its 1 000-result cap on any real J2EE
  estate before the first source was seen — every file under the repository
  root counted, `.git/objects`, `target/`, and `WEB-INF/lib` included, and
  the only override was for read bytes. `Workspace.discover` now takes
  `matching`/`excluding` regexes so the cap counts candidate units;
  `surveyGraph` and `matchingFiles` pass the pack's `sources:` through it;
  `WorkspaceLimits.excludeDirs` prunes `.git`, `.hg`, `.svn`,
  `node_modules`, `target`, `build`, `dist`, and `out` at any depth
  (`LLM4TS_EXCLUDE_DIRS=<names>` replaces the list);
  `legacySourceWorkspaceLimits` allows 20 000 results
  (`LLM4TS_MAX_DISCOVER_RESULTS=<count>` overrides); packs gain an optional
  `exclude:` regex for vendored or generated sources; and the survey aborts
  an overflow with those knobs named instead of a bare limit number.
- **Fixed**: path-shaped edge targets never matched a unit. A JSP include
  of `header.jsp` captured that path while the node was named `header`, so
  every layout fragment showed zero incoming edges and the inventory flagged
  the most-included files in a web estate as retire candidates — with the
  triage prompt told to trust it. `surveyGraph` now folds a capture onto the
  unit whose basename matches; unknown references stay as captured.

## 0.13.5

- `@llm4ts/flow/AzureDevOpsTool` reads and writes a work item's own links,
  the ones Azure DevOps holds natively where a GitHub issue has only prose:
  - `workItemLinks(id)` decodes `System.LinkTypes.*` relations from
    `az boards work-item show --expand relations` into `WorkItemLink`
    values. Artifact links and hyperlinks share that array and are skipped
    here, exactly as `developmentLinks` skips these.
  - `linkWorkItem(id, kind, targetId)` adds one. A work item link takes
    `--target-id`, where an artifact link takes the `--target-url` of a
    `vstfs:` URI — the CLI accepts both flags on the same command, so
    confusing them is silent.
  - `WorkItemLinkKind` covers `Parent`, `Child`, `Related`, `Predecessor`
    and `Successor`, with `linkReferenceName` / `linkKindOfReference`
    mapping to and from the `System.LinkTypes.*` reference names. Forward
    points away from the primary end (a parent's link to its child is
    `Hierarchy-Forward`), and an item's `Predecessor` is the one it waits
    for — which is what "blocked by" means on a board.
  - `workItemIdOfUrl` reads the id from a relation's REST url.

## 0.13.4

- **Fixed**: `LLM4TS_CODER=gemini-cli` ran **claude**. `coderFromEnv`
  matched only the short names (`gemini`, `agy`, …) and its `default:`
  branch returned claude, so any other value — a connector's own id, a
  typo — silently selected a different vendor's CLI. `gemini-cli` is the
  id llm4ts prints in events, traces and errors, which makes it the name
  an operator is most likely to write.

  Every coder now answers to its connector id as well as its short name,
  trimmed and case-insensitively. The ids are derived from the presets, so
  renaming a connector cannot leave a stale alias behind.

- New `coderFromEnvironment` — the checked reading, matching
  `apiConnectorFromEnvironment`: an unset variable is still the claude
  default, but an unknown one fails with `ScriptUsage` naming the coders
  llm4ts knows instead of running one the operator did not ask for. The
  `llm4ts` CLI uses it. `coderFromEnv` keeps its signature and its
  fall-back-to-claude behaviour for existing callers, and now resolves
  aliases.

- New `coderIds` and `coderFor(name)` for consumers that validate their
  own configuration.

## 0.13.3

- **Fixed**: `listWorkItems` crashed with
  `SchemaError: Unexpected end of JSON input` whenever the query matched
  nothing. The Azure CLI prints **nothing** for a command whose
  implementation returns `None` — not `[]` — and `az boards query` returns
  `None` precisely when the WIQL matches no work items. So an empty queue
  arrives as empty stdout with exit code 0, which is the ordinary state of
  a board between pieces of work rather than a failure.

  `parseWorkItems` (and `parseWorkItemIds` through it) now reads empty
  output as no rows. Malformed output is still a decode error: only
  emptiness means "nothing matched".

## 0.13.2

- **Fixed**: every `listWorkItems` call was rejected by Azure DevOps with
  `TF51006: The query statement is missing a FROM clause`. The WIQL was
  built as `SELECT TOP n [System.Id], … FROM WorkItems …`, and WIQL has no
  `TOP` clause — it looks like SQL, but the grammar is only SELECT / FROM /
  WHERE / ORDER BY / ASOF. The row cap is the REST `$top` parameter, which
  `az boards query` gives no way to send. `TOP n` leaves the SELECT list
  unparseable, so the server never reaches FROM and rejects the query
  whole.

  `wiqlFor` no longer emits it, and `WorkItemFilter.limit` is applied to
  the decoded result instead. The query keeps its `ORDER BY [System.Id]
ASC`, so the prefix that survives is exactly the rows `TOP` would have
  returned, in the same order.

- New `defaultWorkItemLimit` (100) in `@llm4ts/flow/AzureDevOpsTool`, the
  cap `listWorkItems` applies when a filter names none.

## 0.13.1

- **Fixed**: CLI tools that install as a `.cmd` on Windows could not be run
  at all. `az` and an npm-installed `gemini` are batch files there, and
  `nodeProcessExecutor` spawns without a shell — which never appends a
  PATHEXT extension (so a bare `az` is not found) and, since
  CVE-2024-27980, refuses to spawn a batch file outright (`spawn EINVAL`).
  The same word typed at a PowerShell prompt works, because a shell does
  both of those things.

  The executor now does them itself, for batch files only: resolve the
  command through PATHEXT, then hand it to `cmd.exe /d /s /c` with each
  argument quoted for the Microsoft C runtime. Turning on Node's
  `shell: true` would not do — it builds its command line as
  `${file} ${args.join(" ")}` with no quoting at all, which splits any
  argument containing a space and hands a WIQL `<>` to cmd.exe as
  redirection.

  Nothing changes off Windows, or on it for a real executable: `git`,
  `node` and `.exe`-shipped CLIs are still spawned directly.

- New `@llm4ts/runner/WindowsCommand`: `quoteArgument`, `resolveCommand`,
  `isBatchFile`, `batchInvocation`, `windowsInvocation` — the pure pieces
  of the above, exported so consumers can reason about them and so they are
  testable on any platform (they use win32 path semantics explicitly rather
  than inheriting the host's).

## 0.13.0

- `@llm4ts/flow/AzureDevOpsTool` reads and writes a work item's
  **Development** section — the links that tie a work item to the git
  objects that implement it, which is how Azure DevOps expresses what
  GitHub gets from an issue living inside a repository:
  - `developmentLinks(id)` decodes the `ArtifactLink` relations
    (`az boards work-item show --expand relations`) into `GitArtifact`
    values. Non-git Development links (builds) and ordinary hierarchy
    relations are skipped rather than half-decoded.
  - `linkArtifact(id, artifact)` adds one, via
    `az boards work-item relation add`.
  - `repository(name?)` resolves a repository's GUIDs through
    `az repos show`, because artifact URIs address projects and
    repositories by id and no caller can derive those from a name.
  - `artifactUri` / `parseArtifactUri` build and read the `vstfs:` URIs
    (`Ref`, `PullRequestId`, `Commit`). The project/repository/value
    triple is one percent-encoded segment, which is what lets a branch
    name keep its slashes; a malformed escape yields `undefined` rather
    than a thrown `URIError`.
- `workItemShowArgs` takes an optional `expand` (`relations` / `all`).
- **Fixed**: a work item whose Development section has never been touched
  omits `relations` entirely rather than sending an empty array. A
  constructor default does not apply on decode, so that — the normal state
  of every work item — would have failed to parse.

## 0.12.0

- **Breaking**: `@llm4ts/flow/AzureDevOpsTool` drives the `az` CLI instead
  of the Azure DevOps REST API (ADR 0011), so it matches the `gh` protocol
  its siblings already use. `makeAzureDevOpsTool` now takes a process
  executor and a working directory where it took an `HttpClient`;
  `AdoRequest`, the `*Request` builders, `authorizationHeader`, and
  `parseWiqlIds` give way to exported argv builders and `--output json`
  parsers
  (`parseWorkItemIds` is the replacement). Every call passes
  `--detect false` so the CLI cannot retarget another organization from a
  git remote, and `quoteWiql` escapes WIQL literals so a tag cannot rewrite
  a query.
- **Breaking, security**: `AdoConfig.pat` is removed. Azure DevOps
  credentials belong to the CLI (`az devops login`, or
  `AZURE_DEVOPS_EXT_PAT` read by `az` itself), exactly as GitHub's belong
  to `gh` — the library no longer accepts, holds, or forwards a token. It
  adds no variables of its own to the `az` process either; the child
  inherits the host's environment, which is how `az` reads that variable,
  so a PAT stays in the environment and never reaches argv or a log.
- `AzureDevOpsTool` grows the control-plane operations the CLI makes cheap:
  `listWorkItems` (one WIQL call returns whole work items, no id fan-out),
  `readComments`, `writeComment`, `createWorkItem`, `editTags`
  (read-merge-write over the semicolon-joined `System.Tags` field, matching
  the service's case-insensitive tags), `openPrForBranch`, `updatePr`,
  `writePrComment`, `prPolicies` (branch-policy evaluations mapped to
  `Success` / `Failure` / `Pending`), and `completePr`. `WorkItem` gains
  `createdBy` and `changedDate`; `createPr` reuses an active pull request
  for the branch instead of failing on a duplicate.

## 0.11.0

- Read-only is a capability removal, not a request (ADR 0010,
  `specs/pending/cli-read-only-enforcement.md`): claude's `readOnly` now
  emits a `--tools Read,Grep,Glob,Skill` allowlist — orca #89 proved plan
  mode removes no tools and a `disallowed-tools` denylist misses `Bash`
  and MCP write tools by construction. `ConnectorCapabilities` gains
  `readOnlyEnforcement` (`enforced` — claude/codex/pi and API providers;
  `advisory` — the plan-mode family; `ignored` — copilot/cursor), the
  capability matrix documents the grades, and the runner publishes
  `CapabilityUnenforceable` when a `readOnly` seat resolves to a
  non-enforced connector. Explicit `flags.tools` wins on conflict.

- Parity: adopt llm4zio v4.3.0 (`0494a4ad`) — bounded context for the
  modernization pipeline (`specs/pending/llm4zio-4.3.0-parity.md`):
  - **Fixed**: `TransientRetry` no longer retries deterministic client
    errors. Gemini wraps every error — including 400s — in
    `[API Error: …]`, so the `"api error"` transient signal retried
    unfixable failures three times and reported them as transient. A
    deterministic-4xx guard now wins; new `isContextOverflow` /
    `isContextOverflowMessage` classifiers share one phrasing list with
    `Context.withShrink`.
  - New `@llm4ts/flow/Context`: `cap` (hard character cap, marker
    included, head ¾ / tail ¼), `capped` (caps, publishes a `FlowEvent`,
    records the truncation), `withShrink` (full → ½ → ¼ retry ladder for
    prompt-too-large failures; exhaustion names the knob), `budget`
    (`LLM4TS_CONTEXT_BUDGET`, default 400k chars, with
    `LLM4TS_JUDGE_SOURCES_LIMIT` as the deprecated alias), `truncations`
    and `isolateTruncations`. Truncations are recorded only by
    `capped`/`withShrink`, so no call site can truncate silently.
  - `Provenance.contextTruncations` (defaulted; old manifests still load)
    — the implement, review, and verify flows append this run's recorded
    truncations to `provenance.json`, so a verdict rendered on a
    partially-read spec pack says so in the evidence chain.
  - `GitTool.diffVsBaseScoped(base, paths)` — path-scoped diff; empty
    paths yield `""` (never the whole diff) and the `GitRead` guard still
    runs, so denials still audit.
  - `Pack.programFiles` template + `filesFor(program)` (compiled
    `RegExp`; case-insensitive name-match fallback), and
    `Survey.closureFor` — the breadth-first, cycle-safe, bounded include
    closure.
  - New `@llm4ts/flow/ProgramJudge`: per-program spec-compliance judging
    (each call sees one program's spec and one program's diff slice),
    cached per program via `ReviewCache`; a spec'd program with no
    matching changed file is a **Critical** finding, not a silent pass.
  - Modernize flows decomposed: implement uses a fresh chat per task and
    per-program judging plus a bounded traceability pass; review scopes
    each lens to the diff of the files it matched and drops the diff from
    the distill prompt; verify triages equivalence failures per program;
    extract hands the analyst a resolved include closure (bounded by
    `LLM4TS_ANALYST_TURNS` / `LLM4TS_MAX_CLOSURE_FILES`) and uses the
    shared Context ladder; survey caps its graph-refine and triage
    prompts.

## 0.10.0

- `BasecampTool.writeCardComment` returns the created `CardComment`
  (parsed from `comments create --json`; it returned void), and the new
  `editCardComment(commentId, body)` updates a comment in place via
  `comments update` — the pair a consumer needs for living work-log
  comments edited as agents work, the same evolution
  `GitHubTool.writeIssueComment` took in 0.7.4 for Nightcall's living
  checklists. Driven by Dunder Mifflin's ongoing-work trace design.

## 0.9.1

- `effect` is pinned to the exact beta (4.0.0-beta.102) in every
  package's peer range and in the pack-smoke consumer. The 0.9.0 release
  gate failed when the caret range resolved effect 4.0.0-beta.104, which
  removed `Schema.TaggedErrorClass`; prerelease betas break APIs, so the
  supported version is now stated exactly. Upgrading the effect pin is a
  deliberate migration, not a range drift. (0.9.0 was never published.)

## 0.9.0

- `BasecampTool` grows the memory/policy surface: `listMessages` and
  `createMessage(title, body)` (posted with `--no-subscribe`) for
  message-board lesson posts, `listTodolists` and `listTodos(id)` for
  read-only checklist rubrics. Message/todolist commands pass `--project`
  only (never `--card-table`); list decoders stay null-tolerant. Driven
  by Dunder Mifflin's agency-memory design: lessons as searchable,
  CEO-curatable messages; policy as CEO-editable todolists.

## 0.8.1

- `BasecampTool` list decoders (`parseCards`, `parseCardComments`,
  `parseColumns`) tolerate the CLI's `null` output for empty listings —
  an empty column printed `null`, not `[]`, and `listCards` failed with a
  parse error. Found by the first consumer (Dunder Mifflin) on its first
  heartbeat against an empty board; steps already handled this.

## 0.8.0

- New `@llm4ts/flow/BasecampTool`: a Basecamp card table as an agent work
  queue, wrapping the `basecamp` CLI through the same `ProcessExecutor`
  protocol, args-builder style, and capability guards as `GitHubTool`.
  Columns are data discovered from the board (one cached fetch per tool
  instance) with case-insensitive `resolveColumn` failing typed
  (`ColumnNotFound` lists the available titles); cards
  list/read/move/create/assign, card comments, and card steps round out
  the claim→work→report→done loop. Card and comment bodies stay verbatim
  rich-text HTML in `contentHtml` fields — writes pass through to the
  CLI, which accepts Markdown. ADR 0009.
- Core capabilities grow `BasecampRead`/`BasecampWrite` and a `basecamp`
  grant level in `Grants`; grants serialized before the field existed
  decode as `"None"`, so old persisted grants deny Basecamp access.

- `GitHubTool.readIssueComments` decodes an issue's comment thread
  (author login, body, createdAt) via `gh issue view --json comments` —
  the read side of the comment channel, letting a consumer's triage agent
  act on human feedback (e.g. an epic-validation loop where the CEO's
  comments seed the next iteration's decomposition).

## 0.7.5

- `GitHubTool` gains `mergePr` (method squash/merge/rebase, optional
  `--delete-branch`) and exposes `viewOpenPr` — the open PR whose head is
  the working directory's current branch. Together with `prChecks`, a
  consumer can implement continuous delivery: verify a PR's checks are
  green and merge it without a human click. Same `gh` protocol and
  `GhRead`/`GhWrite` guards.

## 0.7.4

- `GitHubTool.writeIssueComment` returns the created comment's
  `IssueCommentRef` (parsed from the URL `gh issue comment` prints;
  undefined when absent), and the new `editIssueComment` PATCHes a
  comment body via `gh api` — together they let a consumer post a plan
  as a task-list comment and check items off by editing it as work
  completes. Same protocol and guards; ADR 0008 lineage.

## 0.7.3

- Backend-reported cost reaches invoices. `TokenUsage` gains an optional
  `costUsd`; the Claude CLI connector and agent session parse the result
  event's `total_cost_usd` into it, `CostTracker` sums it per cell and
  prefers it over pricing-table estimates (which only fill in when the
  backend reported nothing), and the result event's `modelUsage` key
  doubles as a model-name fallback so usage stops rendering as
  `(unknown)` when the init line was missed. Driven by a Nightcall run
  that burned 766k coder tokens and invoiced $0.00.
- `implementPlanFlow` accepts `noopTaskPolicy: "complete"`: an unconfirmed
  no-change task is marked complete with an Info notice instead of
  aborting the flow. Default stays `"fail"`. For pipelines whose final
  state is re-judged downstream (CI gate, fresh-context QA), one coder
  that will not utter TASK_ALREADY_SATISFIED no longer sinks a branch of
  otherwise-finished work — the failure mode that killed three attempts
  on the same issue while its importers sat complete and green.

## 0.7.2

- Equivalence observations accept JSON scalars. A replay harness dumping a
  COBOL record emits numerics as JSON numbers, but the observation schema
  required strings, so `{"ZSTC": 0}` failed the whole replay stage with
  `Expected string, got 0 at [0]["fields"]["ZSTC"]` instead of producing a
  diff. Field maps (`fields`, `key`, `set`, and a vector's `inputs`) are now
  canonicalised to strings on every side that reads them — replayed output,
  stored vectors, and the model-generated vectors — so comparison stays
  string-based and symmetric. `null` reads as no value (empty). Note that
  JSON numbers carry no trailing zeros: a harness needing fixed precision
  (money, `PIC 9(5)V99`) should emit those fields as strings, which
  `flows/README.md` now states.

## 0.7.1

- A finished task is no longer lost to a base-ref lookup (issue #8). A
  36-minute implement stage died on `git diff --name-only main...HEAD`, with
  the failure reported as nothing but that command. Three fixes:
  - `defaultBase` returned the literal string `"main"` when it could not find
    a remote HEAD, without checking that any such ref existed. In a repository
    with no remote and a differently named default branch — exactly what
    `modernize-seed` produces — the next diff failed with "unknown revision".
    Every answer is now verified with `rev-parse --verify` (`origin/HEAD`,
    `origin/main`, `origin/master`, `main`, `master`), falling back to the
    branch's root commit so a diff still describes the work.
  - Changed files only narrow which reviewers run, so `reviewAndFixLoop` no
    longer fails when that lookup fails: it publishes an explanatory notice
    and runs every reviewer, which is what an empty list already meant.
  - `ProcessError.message` is only the command that failed. The new
    `describeFlowError` appends the process output that explains it, so stage
    failures and the final "flow failed" line read
    `git diff --name-only main...HEAD: fatal: ambiguous argument …` instead of
    just the command.

## 0.7.0

- Runs show what the agent is doing while it does it (issue #6). A stage
  driving a coding agent rendered as a bare spinner for minutes; two gaps
  caused that:
  - CLI connectors emit a zero-delta chunk per tool call, but `collect` folds
    a stream into its final response and dropped them, so no `ToolUse` event
    was ever published — the terminal already knew how to draw one. The new
    `@llm4ts/flow/Activity` seam (`withToolActivity`, `toolUseFrom`,
    `summariseToolArgs`) republishes them, and `Chat` (with an `events` sink)
    and `completeAndPublish` wrap their streams with it. Arguments are
    summarised to their salient value on one bounded line, so a call renders
    as `● run_shell_command (ls -R docs/modernization)` rather than a JSON
    blob or a whole file body.
  - `makeTransientRetry` — which already published
    `⟳ flaky stream (fresh retry) — retry 1/6: …` notices — was never wired
    to anything. Every seat the runner resolves (coder, reasoning, reviewers)
    is now wrapped, so a flaky CLI stream (empty response, malformed tool
    call) retries visibly instead of failing the whole stage silently. The
    connector's other members, `capabilities` included, are preserved.

## 0.6.3

- Runs report their token usage and cost again (issue #4). Two independent
  faults produced the same "cost: no usage reported (the selected backend
  emits no token counts)" line:
  - The Gemini CLI reports **per-model session metrics** —
    `stats.models["<model>"].tokens` with `prompt`, `input`, `candidates`,
    `thoughts`, `cached`, and `total` — but the stream parser only understood
    a flat `{total_tokens, input_tokens, output_tokens}` shape, so every
    gemini run discarded its counts. `parseGeminiStreamStats` now sums the
    per-model metrics across every model a run touched (a quota fallback
    reports both), maps `prompt` to the uncached input the pricing table
    expects, counts thinking tokens as output, and still accepts the flat
    shape. Partial counts are no longer dropped wholesale.
  - `executeStructured` discards the usage its provider reported, and the
    modernization phases and reviewer lenses are built almost entirely from
    structured calls — so no `TokensUsed` event was published on those paths
    regardless of backend. The new `@llm4ts/flow/Usage` seam
    (`structuredAndPublish`, `publishUsage`, both re-exported from
    `@llm4ts/flow/Flow`) publishes usage alongside the decoded value, and
    survey, extract, verify, review, and the review-and-fix loop now use it.
    A schema retry publishes its own usage, because it costs its own tokens.

  Not yet covered: the structured calls in `Planner` and `PrSummary`, which
  take no event sink today; their usage remains unreported.

## 0.6.2

- The estate-reading modernization phases (survey, extract, bench) open the
  legacy repository with a new `legacySourceWorkspaceLimits`: an 8 MiB
  per-file read cap instead of the 1 MiB workspace default, which failed an
  entire survey on its first multi-megabyte program or generated copybook.
  `LLM4TS_MAX_READ_BYTES=<bytes>` overrides the cap for estates that exceed
  even that, and `WorkspaceLimitError` now names the offending file
  (`read bytes exceeded limit 1048576; received 1659258 (path/to/file)`), so
  a limit hit is actionable without a debugger.

## 0.6.1

- The built-in flow tier ships transpiled JavaScript instead of TypeScript.
  Node refuses to strip types from `.ts` files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so an installed
  `@llm4ts/shell` (npx, `npm install -g`) crashed on `llm4ts run <flow>` —
  0.6.0's from-anywhere pack discovery only worked from a repo checkout.
  `sync-shell-flows` now transpiles each flow with the TypeScript compiler,
  flow discovery accepts `.js` alongside user-authored `.ts` flows (project
  and global tiers are unchanged), and the pack smoke test now launches a
  built-in flow from the installed `node_modules` layout — the check that
  would have caught this before publish.

## 0.6.0

- Modernization pack discovery no longer requires launching from a directory
  that holds `packs/`. The new `@llm4ts/runner/Packs` seam (`openPack`,
  `locatePack`, `loadUniversalPatternCards`) resolves `LLM4TS_PACK` (default
  `packs/cobol-springboot`) against the launch directory first, then against
  the flow script's own directory; an absolute `LLM4TS_PACK` is used as-is,
  and a missing pack fails with a `PackNotFound` error naming both searched
  roots instead of an opaque `pack.md` read error. All seven modernize flows
  route through the seam, and pack-relative reads (prompts, pack patterns,
  `lessons.md`, the scaffold) follow the directory the pack was actually
  found in.
- `@llm4ts/shell` now ships the modernization resources its built-in flows
  need: `sync-shell-flows` copies `packs/`, `patterns/`, and `fixtures/`
  alongside the flow scripts, and `@llm4ts/modernize` joins the shell's
  dependencies so the built-in modernize flows resolve. Together with the
  discovery fallback, `llm4ts run modernize-survey --repo <estate>` works
  from any directory.
- `llm4ts run` accepts `--repo <path>` directly and forwards it to the flow,
  matching `llm4ts ask`; previously only the `run <flow> -- --repo <path>`
  spelling reached the flow.
- `flows/README.md` documents the pnpm workspace footgun the discovery
  fallback cannot fix: `pnpm --filter @llm4ts/flows …` invoked outside the
  llm4ts checkout prints pnpm's `No projects found in "<dir>"` and exits 0
  without running anything — a message easily mistaken for the Gemini
  "No project found" credential error that `llm4ts doctor` explains.
- The Release workflow gains a `workflow_dispatch` trigger: run it manually
  against `main` after a version bump and it verifies the lockstep versions,
  runs the full verification chain, publishes, and pushes the matching
  `vX.Y.Z` tag itself. Tag-driven releases behave exactly as before.

## 0.5.0

- `@llm4ts/flow/GitHubTool` gains `createIssue` (title, body, labels;
  returns the parsed `IssueRef`), completing the work-queue surface for
  consumer-side epic decomposition — a triage agent splitting one epic
  issue into child work items. Same `gh` process protocol, `GhWrite`
  guard, and args-builder style; ADR 0008 amended accordingly.

## 0.4.0

- `@llm4ts/flow/GitHubTool` gains four work-queue operations so a GitHub
  repository can serve as an agent work queue: `listIssues` (label, state,
  and assignee filters, schema-decoded into the new `IssueSummary` via the
  new `RepoRef`), `editIssueLabels` (repeated add/remove flags; an edit
  with no labels on either side is a no-op that never spawns `gh`),
  `assignIssue`, and `closeIssue`. All four follow the existing `gh`
  process protocol and are guarded by `GhRead`/`GhWrite`. This is an
  intentional additive extension beyond the pinned llm4zio v4.2.0 `GhTool`
  surface, recorded in ADR 0008 and the parity ledger; the first consumer
  is the Nightcall work-queue orchestrator.

## 0.3.1

- `llm4ts doctor` gains a prerequisites section: environment a connector needs
  before a run starts, as opposed to whether its CLI is installed. The first
  check covers the Gemini CLI, which resolves credentials during auth setup and
  fails a Workspace or enterprise account with "No project found" when neither
  `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT_ID`, `GEMINI_API_KEY`, nor a
  Vertex AI configuration is present — a message that names nothing about
  llm4ts. A personal OAuth login needs no environment at all, so an
  unconfigured environment is reported as a caveat rather than a failure, and
  the hint names the shell-startup trap that commonly hides the variable from
  non-interactive shells and IDE terminals. Key values are never echoed.

## 0.3.0

- Legacy modernization reaches full parity with the pinned source's example
  suite. The four target-side phases ship as flows —
  `modernize-seed` (deterministic clean-room seeding with a provenance
  manifest), `modernize-implement` (per-task implementation behind the pack's
  gates, plus a branch-level spec-compliance judge), `modernize-verify`
  (generated equivalence vectors, replay, rule coverage, failure triage into
  plan tasks), and `modernize-review` (lens review distilled into fixes,
  improvements, and pack lessons) — alongside `modernize-bench`, which
  measures an extraction run and feeds the survey's per-wave cost projection.
- New `@llm4ts/flow/Wall` enforces the clean-room boundary every target-side
  phase checks, and `@llm4ts/flow/Patterns` loads the translation pattern
  cards extraction tags and implementation injects. Both are covered by
  deterministic tests.
- `modernize-extract` closes its remaining fidelity gaps: per-program judge
  verdicts are cached and fingerprinted (`gate/<NAME>.json`), an empty judge
  response retries at half then quarter context, traceability fragments are
  tagged with the pattern cards their source matches, and a turn-limit trip
  after the artifact landed keeps the work.
- All six reference packs ship under `flows/packs/` — `cobol-springboot`,
  `cobol-kafka`, `ace-integration`, `ace-kafka`, `jsp-bff-nextjs`, and
  `jsp-nextjs` — with the four target scaffolds they seed
  (`spring-boot-service`, `kafka-streams-service`, `spring-bff`, `nextjs-spa`),
  25 universal COBOL pattern cards, and `cobol-kafka`'s pack-local
  event-streaming cards. `flows/test/pack.test.ts` validates every pack:
  manifest fields, gates, judge rubric, compilable coverage/survey regexes,
  prompt sidecars, reviewer lenses, and that each declared scaffold and replay
  script actually ships. `@llm4ts/flow/Package` now exposes `packageVersion`
  for provenance manifests.

- Every modernization phase is covered by an offline end-to-end smoke: the
  flows, runner, pack loader, gates, replay harness, and git all run for real
  with only the coding-agent binary stubbed. Three bugs surfaced and were
  fixed: `${dir}/**/*` never matched files directly under a directory, so
  `modernize-seed` silently copied zero specs and still reported success (the
  same glob was gathering spec text in `-implement` and `-review`);
  `modernize-verify` built its provenance update as a plain object, which the
  schema encoder rejected at the end of an otherwise successful run; and
  `modernize-implement` left the final task's plan update uncommitted.
- `modernize-bench` now measures tokens, not just wall-clock: structured calls
  report their usage through the event tap, and the evaluator's seat is
  wrapped so judge tokens are attributed too.
- `modernize-seed` aborts when a spec pack contributes no specs instead of
  seeding an empty target.

## 0.2.2

- New modernization flows, porting `llm4zio`'s legacy-rooted phases:
  `flows/modernize-survey.ts` (deterministic dependency graph, LLM
  graph-refine with evidence, triage, human-approved wave plan) and
  `flows/modernize-extract.ts` (per-program resumable spec extraction,
  layered SpecChecks + LLM-judge gate, bounded fix rounds, approval-gated
  spec pack). Both ship as shell built-ins; the target-side phases are
  queued in `specs/pending/modernize-flow-suite.md`, with divergences
  recorded in `docs/parity.md`.

## 0.2.1

- Republish: `@llm4ts/shell@0.2.0` reached npm with unrewritten
  `workspace:*` dependency ranges (published with `npm publish` instead of
  `pnpm publish`) and was uninstallable. 0.2.1 is identical in content
  across all packages and published via the release workflow.

## 0.2.0

- **Breaking:** the `llm4ts` bin moves from `@llm4ts/runner` to the new
  `@llm4ts/shell` package (ADR 0006). The old bin's behavior survives as
  explicit verbs: `llm4ts ask "<prompt>" [--repo <path>]` (one-shot
  streaming) and `llm4ts doctor`. `@llm4ts/runner` keeps `Cli` and `Doctor`
  as library exports.
- New `@llm4ts/shell`: three-tier flow discovery
  (`.llm4ts/flows/` > `~/.config/llm4ts/flows/` > built-ins), `run` /
  `list --json` / `view` verbs, an interactive menu with a per-run coder
  override, and child-process flow execution with project-wins module
  resolution. Try it with `npx -y @llm4ts/shell`.
- The runnable agent flows moved from `examples/` to a top-level `flows/`
  directory and now double as the shell's built-in flows; each flow's first
  line is a `//` description the shell lists. `examples/support.ts` is gone —
  flows import the published `@llm4ts/runner` subpaths directly.

## 0.1.4

- `implementPlanFlow` gains `chatPerTask`: each task can run in a fresh
  `Chat` seeded with the configured system prompt plus the plan's current
  completion state, with review-fix rounds sharing that task's chat
  (ADR 0003). `implementTaskLoop` threads the progressing plan into its
  per-task callback.
- No-change tasks are no longer inferred complete: the coder is asked to
  confirm with a literal `TASK_ALREADY_SATISFIED`, and a silent no-op fails
  the task instead of marking it done. Commit-refusal messages now carry
  the tail of the failing gate's output.
- New `docs/flow-authoring.md` — the rung-by-rung guide from one-shot
  prompts to custom spines — pinned to real sources by sync tests.
- Specs are read-only for autonomous agents (ADR 0004).

## 0.1.3

- Review-loop robustness at the structured-output boundary: decoding-side
  defaults for reviewer/judge/plan schemas (a model omitting an optional
  field no longer hard-fails the flow), one bounded reviewer retry on parse
  errors, review diffs switched to `git diffAll` so untracked new files are
  visible to reviewers, empty-diff tasks skip review and commit, and
  `implementPlanFlow` refuses to commit while a configured lint gate is
  still failing after review settles.
- Ralph-grade terminal observability: run header with seats and trace path,
  per-stage durations, `LLM4TS_TIMESTAMPS=1` line timestamps, honest cost
  summary (no empty sections; explicit note when a backend reports no token
  counts), and a closing line with total duration and stage counts.

## 0.1.2

- No library changes. Added `pnpm version:set` for lockstep version bumps,
  the Ralph autonomous-loop tooling (`ralph-auto.sh`, `RALPH_AUTO_PROMPT.md`,
  `specs/`), and engineering-guide updates.

## 0.1.1

- No functional changes. Releases now publish through npm trusted publishing
  (OIDC) instead of a long-lived token, with provenance attestation retained.

## 0.1.0

- Added `@llm4ts/flow/Flow` with `implementPlanFlow` (the plan → branch →
  per-task coder/review/commit spine) and `completeAndPublish`; examples now
  compose it instead of hand-assembling the loop.
- Added the `llm4ts` CLI `--help`, `--version`, and `doctor` (connector and
  credential health report); errors now name the environment variable or
  missing binary that fixes them.
- Promoted `LLM4TS_PROVIDER`/`LLM4TS_MODEL` resolution
  (`apiConnectorFromEnvironment`) and script helpers (`resolveFlowInput`,
  `runFlowMain`) from the examples into `@llm4ts/runner`.
- Introduced `makeApiConnector` and CLI `versionProbe` factory seams; the six
  API providers and eight CLI connectors now share health, structured-output,
  and capability derivation.
- Consolidated connector identity (`connectorProvider`,
  `connectorDefaultBaseUrl`) and removed a silent OpenAI base-URL fallback for
  unknown API connector ids.
- Shipped in-memory `PlainFileStore`/`Workspace` fakes in `@llm4ts/flow` for
  deterministic tests; flow behavior tests moved into the flow package.
- Removed unused `LlmService` accessor functions, per-provider layer
  constructors, and pass-through streaming aliases (ADR 0002); `effect` is now
  a pinned peer dependency and packages ship LICENSE, README, and source maps.

- Recreated the public LLM, connector, provider, streaming, tool, evaluation,
  observability, flow, repository, replay, cost, benchmark, and equivalence
  contracts from the owned `llm4zio` v4.2.0 baseline.
- Added Node runtime composition, CLI and MCP stdio entry points, terminal
  rendering, and a credential-free executable example.
- Added the six-phase resumable modernization product with human approval gates.
- Added the Promise/exception JavaScript facade and reproducible npm package
  metadata.
- Added source-compatible API configuration enrichment at runner resolution,
  including default endpoints, redacted environment credentials, and target
  repository rooting for CLI agents.
- Added opt-in real examples for HTTP providers, edit-capable coding CLIs, a
  fully local LM Studio-to-pi handoff, and repeated LLM-as-a-Judge evaluation.
- Added atomic stateful chat, structured planning/readiness, file-scoped bounded
  review/fix loops, lint gates, and structured pull-request summaries.
- Added resumable implementation, GitHub issue-to-PR, and executable
  specification-driven development examples.
- Added disposable Rust, Scala, and Java starter repositories plus a seed/run
  script for complete implementation, local, issue-to-PR, and SDD workflows.
