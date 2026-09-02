# Changelog

## Unreleased

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
