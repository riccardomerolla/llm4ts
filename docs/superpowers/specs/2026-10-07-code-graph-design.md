# Code graph: sub-file nodes, declarative joins, probes, a distilled cache

Date: 2026-10-07 · Status: implemented in 2.38.0 (ADR 0030)

## The problem as observed

The modernize flows build a dependency graph of the legacy estate
(`packages/flow/src/Survey.ts`): one node per source file, one edge per regex
capture of a pack's `## Survey:` rule. On the bank estate (J2EE servlets, JSP,
jQuery, ESB wrappers, COBOL) it fails in three ways:

1. `modernize-survey` writes `graph.json` and refines it with an LLM pass, but
   `modernize-extract`, `modernize-refine` and the j2ee convert flow rebuild
   the graph from the regexes. Every LLM edge is lost.
2. A file is the only node. `$.ajax({url: "/salvaFattura"})` in `invoice.js`
   and the `web.xml` mapping of `/salvaFattura` to `InvoiceServlet` live in
   different files and need a join, not a capture; the current rule produces
   an edge from the page to the literal string `/salvaFattura`. COBOL
   paragraphs and `PERFORM` edges have the same shape.
3. The LLM pass asks for "any missed edge" in the whole estate and accepts a
   free-text evidence string.

## What we learned from codegraph

[colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) is the
shelf product for the symbol index ADR 0025 parked: tree-sitter, twenty
languages, SQLite + FTS5, a watcher, one MCP tool (`codegraph_explore`) that
returns verbatim source grouped by file, the call path and a blast radius in
a 25k-character budget. We do not depend on it: it has no JSP, `web.xml`,
servlet mapping or ajax-to-route link, and it is a native kernel with a
daemon. We distil seven of its disciplines:

| Their rule                                                                                           | Our form                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| "coverage must close end to end; partial coverage is worse than none", enforced by `trace(from, to)` | `## Probe:` sections in the pack; pack-check fails on a broken probe; the bank's hand-extracted flows become probes |
| `provenance` + `metadata.synthesizedBy` on every edge, precision checked per mechanism               | `rule` and `mechanism` on every edge; `graph stats` breaks edges down by both                                       |
| "the route table must be per app"                                                                    | `scope: app` is the default of a `url` join; an app root is the directory containing `WEB-INF`                      |
| budget allocated by relevance, spine files protected, off-spine siblings skeletonised                | spine-first closure for the analyst, shipped after the graph and measured with `llm4ts profile`                     |
| directed (bidirectional shortest) and named (chain) flow modes                                       | directed now (`graph path a b`); the chain mode waits for a coder seat                                              |
| COBOL: sections and paragraphs, `PERFORM`/`GO TO`, `PERFORM … THRU`, `CALL`, `COPY`                  | the cobol packs gain `SECTION` nodes, `GO TO` edges, `THRU` range expansion                                         |
| an index other tools can import                                                                      | `origin: external, mechanism: codegraph` reserved for a later, probed, never-required adapter                       |

Not taken: the watcher and daemon (our flows are batch and content-hashed),
session dedup (coder seat, release 2).

## Decisions (from the grilling, 2026-10-07)

| Topic       | Decision                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Consumer    | Modernize flows first; a seat tool and the target-repo graph are release 2, on profile evidence                                                                                                                                                  |
| Repo        | Legacy repo only, via the modernize packs                                                                                                                                                                                                        |
| Module      | `Survey.ts` generalised in place; file nodes are `kind: file`; projections keep `closureFor` and `clusterPrograms` unchanged                                                                                                                     |
| Ids         | `<kind>:<path>#<name>`, `L<line>` when a rule captures no name, `~n` for duplicates in one file                                                                                                                                                  |
| Rules       | Declarative only in `pack.md`: `## Node:`, `## Edge:`, `## Join:`, `## Probe:`, `## Graph`; `## Survey:` keeps working                                                                                                                           |
| URL join    | Servlet-spec matching after normalisation: exact, then `/*` prefix, then `*.ext`; recorded on the edge; scoped per app by default                                                                                                                |
| COBOL       | Section and paragraph nodes; `PERFORM`, `PERFORM … THRU`, `GO TO` edges alongside `CALL`/`COPY`                                                                                                                                                  |
| Extraction  | Scanner pass, then an LLM worklist on the read-only analyst seat; the LLM fills attrs and adds edges between existing nodes, never nodes; output schema-validated and evidence-verified                                                          |
| Persistence | `.llm4ts/graph/<pack>.json` cache; `docs/modernization/graph.json` and `graph.dot` are exports; staleness by file content hash; LLM and external contributions survive while their evidence file is unchanged                                    |
| Entry point | `buildCodeGraph(...)` in flow; `modernize-survey` and `llm4ts graph build` call it                                                                                                                                                               |
| Consumers   | Extract, refine and convert read the persisted graph; survey's inventory gains per-cluster mermaid and entry paths; extract prepends each program's closure diagram to its spec; pack-check gains counts, the unresolved list and probe verdicts |
| CLI         | `graph build \| query \| path \| closure \| stats \| probe`, `--format text\|json\|mermaid\|dot`; mermaid refuses above 150 nodes unless `--force`; whole estate needs `--all`                                                                   |
| Render      | One view model, two emitters; subgraph per file, class or shape per kind, dotted for inferred, red for unresolved, id in a trailing comment                                                                                                      |
| Tests       | One shared fixture estate for the j2ee and cobol vocabularies; golden assertions after the scanner and after a faked LLM pass                                                                                                                    |
| Gate        | Bank pack probes in pack-check: ≥ 80 % of hand-extracted flows connected after the scanner pass; ≥ 95 % of their named nodes present after the LLM pass                                                                                          |
| Delivery    | ADR 0030, `authoring-llm4ts-packs` updated, written plan executed with TDD, 2.38.0                                                                                                                                                               |

Two refinements made while writing the plan, both narrower than the grilling:

- **Staleness is content, not revision.** The cache records a sha256 per
  scanned file and the rule hash; it is fresh when all match. A revision is
  recorded for humans only. This handles dirty trees and legacy repos that
  are not the flow's git repository.
- **The CLI build is the scanner pass.** The LLM worklist runs inside
  `modernize-survey`, which already has a seat, events and budgets.
  `LLM4TS_GRAPH_REFINE=off` keeps its meaning there.

Three facts are still owed by the user and gate the release, not the build:
where the hand-extracted flow docs live (they become probes), the ESB call
pattern in the Java code, and the estate size.

## Data model

```ts
// Survey.ts — every new field is optional on the wire so a v1 graph.json decodes
SurveyNode {
  path, name, lines, units,                       // unchanged
  id?: string            // nodeId(node) = id ?? name
  kind?: string          // nodeKind(node) = kind ?? "file"
  label?: string         // nodeLabel(node) = label ?? name
  lineStart?: Int        // 1
  lineEnd?: Int          // 0 = to end of file
  attrs?: Record<string, string>
  origin?: "scanner" | "llm" | "external"
  descriptor?: boolean   // wiring record: contracted by projection
  anchor?: string        // attr naming the unit this node stands for
}
SurveyEdge {
  from, to, kind,                                  // unchanged (ids)
  origin?: "scanner" | "llm" | "external"          // scanner
  confidence?: "exact" | "inferred"                // exact
  rule?: string                                    // pack section name
  mechanism?: "capture" | "join:exact" | "join:url" | "contraction" | "llm" | "codegraph"
  join?: "exact" | "prefix" | "extension"
  evidence?: { file, line: Int, snippet }
}
Unresolved { reason: "edge-target" | "missing-attr" | "join-from" | "join-to" | "isolated",
             rule, node: string /* id */, reference?: string, file, line: Int }
Fill { node, key, value, evidence: { file, line, snippet } }
SurveyGraph { nodes, edges, unresolved: Unresolved[] = [], fills: Fill[] = [] }
```

## Pack DSL

```markdown
## Node: servlet-mapping

files: ._web\.xml
pattern: <servlet-mapping>\s_<servlet-name>(?<name>[^<]+)</servlet-name>\s\*<url-pattern>(?<url>[^<]+)</url-pattern>
descriptor: yes

## Node: servlet-decl

files: ._web\.xml
pattern: <servlet>\s_<servlet-name>(?<name>[^<]+)</servlet-name>(?:(?!</servlet>)[\s\S])_?<servlet-class>(?:[a-z0-9_]+\.)_(?<class>[A-Za-z0-9_]+)</servlet-class>
descriptor: yes
anchor: class

## Node: ajax-call

files: ._\.(js|jsp)
pattern: (?:url:\s_|\$\.(?:get|post)\(\s\*)['"](?<name>[^'"]+)['"]
attrs: url=name

## Node: cobol-section

files: ._\.(cbl|CBL)
pattern: ^ {7}(?<name>[A-Z0-9][A-Z0-9-]_) +SECTION\.

## Node: cobol-paragraph

files: .\*\.(cbl|CBL)
pattern: ^ {7}(?<name>\d{4}-[A-Z0-9-]+)\.

## Edge: performs

files: .\*\.(cbl|CBL)
pattern: PERFORM +(?<to>\d{4}-[A-Z0-9-]+)(?: +THRU +(?<thru>\d{4}-[A-Z0-9-]+))?
from: cobol-paragraph
to: cobol-paragraph

## Edge: goes-to

files: .\*\.(cbl|CBL)
pattern: GO +TO +(?<to>\d{4}-[A-Z0-9-]+)
from: cobol-paragraph
to: cobol-paragraph

## Join: jsp-ajax-target

from: ajax-call.url
to: servlet-mapping.url
match: url

## Join: servlet-wiring

from: servlet-mapping.name
to: servlet-decl.name
scope: file

## Probe: save-invoice

from: file:fattura
to: file:InvoiceServlet

## Graph

- worklist-max: 200
- batch-size: 20
```

Semantics:

- Patterns run with flags `gm`. A Node pattern must have a `(?<name>…)`
  group; every other named group becomes an attr; `attrs: a=b, c=d` copies
  group `b` into attr `a` as well. Line numbers come from the match offset.
  A node's `lineEnd` is the line before the next node of the same kind in
  the same file, else the file's last line.
- An Edge pattern must have a `(?<to>…)` group and may have a `(?<thru>…)`
  group. `from:` is the enclosing node of that kind (greatest `lineStart` ≤
  the match line in the same file), else the file node. `to:` is resolved
  among nodes of that kind in the same file first, then anywhere by name;
  `to: file` uses today's `resolveUnit`. With `thru`, every node of the kind
  whose `lineStart` lies between the two targets (same file, inclusive) gets
  an edge. A `file` target the estate does not contain is kept as an edge to
  the literal (today's behaviour) and listed as unresolved; a sub-file target
  that does not exist is listed only.
- `## Survey: <name>` is `## Edge: <name>` with `from: file`, `to: file` and
  `pattern:` = `unit:`.
- A Join creates an edge of its kind from every `from` node whose attr
  matches a `to` node's attr. Several Join sections may share a kind.
  `match: url` normalises both sides: strip a leading `${…}` or `<%=…%>`
  segment, scheme and host, query, fragment and trailing slash; prefix a
  missing `/`. Then exact, longest `/*` prefix, `*.ext`. `scope: file`
  restricts candidates to the same file; `scope: app` to the same app root
  (the longest scanned directory `D` such that some scanned path starts with
  `D/WEB-INF/`; files under no app root share the estate scope); `scope:
estate` is unrestricted. A `url` join defaults to `app`, an `exact` join to
  `estate`.
- A Probe names two nodes by reference: a full id, `<kind>:<name>`, or a bare
  name (file unit). It passes when `shortestPath` finds a path within 12
  hops in either direction on the raw graph.
- Unresolved after joins: a `from` node lacking the attr (`missing-attr`), a
  `from` node with the attr but no edge of the join kind (`join-from`), a
  `to` node with no incoming edge of the kind (`join-to`), and a file node
  with degree zero in the projection (`isolated`).

## File projection

`projectToFiles(graph)`:

1. Unit of a node: a file node → its name; a node whose `anchor` attr names a
   known unit → that unit; otherwise its own file's unit.
2. Descriptor nodes with outgoing edges are contracted: for each incoming
   edge `a → d` and outgoing `d → b`, emit `a → b` with the incoming edge's
   kind and `mechanism: contraction`, repeating until no descriptor remains
   on an edge (bounded by the node count). A descriptor without outgoing
   edges maps to its unit.
3. Map every edge to unit → unit; drop self loops; dedupe by (from, to,
   kind); confidence is `inferred` if any contracted segment was.

`closureFor` and `clusterPrograms` call it internally; on a graph without
sub-file nodes it is the identity, so no existing consumer changes.

## Build, cache, worklist

- `buildCodeGraph(workspace, {sources, exclude?, coverage, rules})` →
  `{graph, files: {path: sha256}}`. `surveyGraph(...)` delegates with Survey
  rules only and returns `.graph`.
- `applyFillsAndJoins(graph, fills, rules)` is a pure step rerun after every
  LLM merge and every carry-over.
- `GraphCache`: `graphCachePath(repoRoot, packName)`, envelope
  `{meta: {version: 2, pack, rulesHash, rev?, builtAt, files}, graph}` via
  `saveVersioned`/`loadVersioned`. `freshGraph(files, path, pack, workspace)`
  returns the cached graph when the rule hash and every file hash match;
  otherwise rebuilds the scanner layer, carries over `llm` and `external`
  edges and fills whose evidence file hash is unchanged and whose endpoints
  exist, reapplies joins, saves and returns.
- `GraphWorklist`: `worklistOf(graph, read, max)` sorts unresolved items by
  the degree of their node, descending; each item carries the node, fifteen
  lines of context either side, and up to eight lexical candidates.
  `worklistPrompt(batch, guidance)`; `WorklistAnswer` =
  `{edges: [{from, to, kind, evidence}], attrs: [{node, key, value, evidence}], notes}`;
  `verifyWorklistAnswer(answer, graph, read)` checks that the trimmed snippet
  occurs within two lines of the stated line and both endpoints exist;
  `mergeWorklist(graph, verified, rules)` adds edges with
  `origin: llm, confidence: inferred, mechanism: llm`, appends fills, reruns
  joins.

## Queries and rendering

`GraphQuery`: `searchNodes(graph, text, {kind?, limit?})` (substring over
id, name, label, path and attr values; a hit's file-mates get a co-location
boost), `neighborhood(graph, ids, hops)`, `shortestPath(graph, from, to,
maxHops)` (bidirectional BFS), `pathBetween` (both directions),
`closureView(graph, program, maxFiles)`, `graphStats(graph)` (per kind,
origin, mechanism, confidence; unresolved by reason), `resolveNodeRef`,
`probeResults(graph, probes)`. All return a `GraphView {nodes, edges}` or
plain data.

`GraphRender`: `renderGraphMermaid(view, graph, {cap: 150, force: false})`,
`renderGraphDot(view, graph)`, `renderGraphText(view)`,
`renderEntryPaths(graph)`, `renderClusterDiagrams(graph, consolidate)`.
Reserved kind styles live in a fixed table; unknown kinds get the neutral
style.

## CLI

`llm4ts graph build|query|path|closure|stats|probe --repo <dir> [--pack
<name>] [--format text|json|mermaid|dot] [--kind k] [--hops n] [--max n]
[--all] [--force]`. Runner module `@llm4ts/runner/Graph` exports
`makeGraphProgram` and `nodeGraphDependencies`; the shell wires the verb.

## Flows

- `modernize-survey`: `freshGraph` with the pack's rules; writes
  `inventory.md` (table, `## Clusters` with one mermaid block each,
  `## Entry paths`), `graph.json`, `graph.dot`; the refine stage is the
  worklist loop; `graph-refine.md` lists accepted and dropped items.
- `modernize-extract`, `modernize-refine`, j2ee `convert`: `freshGraph` in
  place of `surveyGraph`; extract prepends `## Dependency closure` with the
  program's closure diagram to each spec.
- `modernize-pack-check`: per Node/Edge/Join rule counts and samples,
  duplicate names, the unresolved list by reason, one line per probe with
  its verdict; a broken probe is a failure (exit 1).
- Spine-first closure (after the graph lands): `closureFor` ranks files by
  hop distance along join and probe paths from the program before BFS order,
  and `programAsk` spends its budget in that order, listing the remainder as
  paths. Measured with `llm4ts profile` on an extract run before and after.

## Release gate

Bank pack, after `modernize-survey`: probes for the hand-extracted flows
pass in pack-check at or above 80 percent after the scanner pass; the nodes
those flows name exist at or above 95 percent after the LLM pass. Fixture
tests and smoke tests gate CI.

## Spine-first measurement

Not measured in the 2.38.0 session: no legacy estate was available to run
`modernize-extract` against, so the spine-first closure (plan Task 16) is
deferred by its own Step 0. It is taken up when an extract on a real estate
shows closures truncated at `LLM4TS_MAX_CLOSURE_FILES`, with `llm4ts profile
--against` before and after.
