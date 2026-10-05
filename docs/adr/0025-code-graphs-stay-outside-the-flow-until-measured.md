# ADR 0025: Code Graphs Stay Outside The Flow Until Measured

Status: Accepted · Date: 2026-10-05

## Context

CodeGraph (codegraph-ai) parses a repository with tree-sitter into a local
graph of files, symbols, imports, calls and routes, and serves it to coding
agents as an MCP server that Claude Code, Codex and other CLIs pick up from
their own configuration. The question was whether to wire it into
`epic-stories`, or to make it a feature of the library.

Both seats of `epic-stories` are CLI agents with their own tools. The
reasoning seat splits the epic after reading the target's code itself (the
planner prompt says so), reviews every task and judges every story; the
coder seat implements inside a per-story worktree. The library never reads
the target's structure on their behalf: it hands them `CONTRIBUTING.md`
under the context budget, and everything structural in the story plan —
`owned`, `sharedReadOnly`, `dependsOn`, `provides` — is the planner's word.
`validateStoryPlan` checks that word only against itself: unique ids, known
and acyclic dependencies, pairwise disjoint ownership. `checkPerimeter` is
by path prefix, on purpose (ADR 0013). A plan whose ownership does not
match how the code actually imports surfaces late, as a `BLOCKED_ON`
sentinel, a perimeter violation or a merge conflict, after a coder has
spent its tokens.

The library already holds one code graph: `@llm4ts/flow/Survey` builds a
nodes-and-typed-edges `SurveyGraph` from the pack's regex rules, with
`closureFor` walking a unit's transitive dependencies, and the
`modernize-survey` flow lets a read-only reasoning pass propose the edges
the regexes missed. It exists because the legacy estates are COBOL and
JSP, which no tree-sitter graph covers; CodeGraph's community build omits
COBOL.

## Decision

1. **No binding to CodeGraph in the library or the flow.** A graph server
   the coder CLIs detect on their own is a target-repository install, not
   llm4ts code. Its headline benefit, fewer tokens spent grepping, lands
   entirely on the seats' side and needs nothing from the flow.
2. **Measure before building.** The internet-banking runbook gains a
   measurement protocol: the same epic planned and run with and without
   the graph attached to the seats, compared on plan validity against the
   committed fixture split, `BLOCKED_ON` stops, perimeter violations,
   merge conflicts, and the report's estimated usage. The two seats are
   measured apart: the fixture plan copied over the generated one isolates
   the coders from the planner.
3. **If the plans are the gap, the feature is a graph port, not an
   adapter.** The only thing a CLI install cannot do is make the plan's
   structure checkable by code before any coder runs. That feature lives in
   `@llm4ts/flow` as a `RepoGraph` service over the shape `SurveyGraph`
   already has, with the regex survey as one layer and a tree-sitter graph
   as another, provided by the runner like every other Node adapter, with
   an in-src fake for tests. Its consumers are `validateStoryPlan` (a
   story importing from another story's `owned` set without depending on
   it; a `sharedReadOnly` set missing what the owned files import; a
   `provides` entry that does not exist after the merge) and the story
   prompt's read-only context, derived from the closure instead of listed
   by the planner. It never lands in `flows/lib/epic-stories.ts` as a
   one-off.
4. **The perimeter stays a path contract.** A story whose symbol change
   breaks an importer outside its paths is the judge's and the gates'
   concern, as today. Moving the perimeter from paths to symbols would be a
   new ADR, not a consequence of having a graph.
5. **Default CI stays free of the binary.** Whatever the port of decision 3 adds, the
   graph is a layer: tests run against the fake and the regex survey; the
   tree-sitter graph is probed like a CLI connector and reported by
   `llm4ts doctor`.

## Consequences

- Nothing changes in the packages. The runbook documents how to attach the
  graph to the seats and what to count; the result decides whether the port of decision 3
  is specified.
- The index is per workspace and `epic-stories` runs each story in its
  own worktree beside the repository, so a graph attached at the repository
  is stale or absent in every worktree. The runbook's protocol builds it
  in the worktree setup step; a port inherits the same cost at
  `--concurrency` and must account for it.
- The `mainframe-java` kit keeps the regex survey whatever the outcome; a
  `RepoGraph` port with two layers is what lets both kits share the plan
  checks.
