# ADR 0030: Code Graph — Sub-File Nodes, Declarative Joins, Probes, a Distilled Cache

Status: Proposed · Date: 2026-10-07

## Context

The modernize flows already build a dependency graph of the legacy estate:
`packages/flow/src/Survey.ts` keys one node per source file (its basename
without extension) and one edge per regex capture of a pack's `## Survey:`
rule. `modernize-survey` writes it to `docs/modernization/graph.json`, then a
read-only seat proposes the edges the regexes missed, tagged `llm-<kind>`.

Three things are wrong with it on the bank estate (J2EE servlets, JSP,
jQuery, ESB wrappers, COBOL):

1. **Nothing reads the graph back.** `modernize-extract`, `modernize-refine`
   and the j2ee kit's convert flow each rebuild it from the regexes, so every
   LLM edge is lost the moment survey ends.
2. **A file is the only node.** The link that matters most in a web estate —
   a `$.ajax({url: "/salvaFattura"})` call in one file to the servlet that
   `web.xml` maps that URL to in another — cannot be expressed as a single
   regex over a single file. The current `jsp-ajax-target` rule produces an
   edge from the page to the literal string `/salvaFattura`, which no node
   owns. COBOL paragraphs and `PERFORM` edges have the same problem.
3. **The LLM pass is unbounded.** It is asked to find any missed edge in the
   whole estate; it scales with unit count, and a proposed edge is accepted on
   a free-text evidence string.

ADR 0025 parked "a symbol-level code index" for `epic-stories` pending
profile evidence. That index exists as a shelf product:
[colbymchenry/codegraph](https://github.com/colbymchenry/codegraph), a
tree-sitter symbol graph for twenty languages (COBOL and Java among them) in
SQLite with FTS5, kept fresh by a file watcher, exposed to agents as one MCP
tool that answers "how does X reach Y" with verbatim source, the call path
and a blast radius inside a byte budget. We read it before deciding.

It does not solve the bank's problem: it has no JSP, no `web.xml`, no servlet
mappings and no front-end ajax-to-route link (its Spring support is "route
nodes and no navigation"). It is a native kernel with a daemon and a
database, which ADR 0007 and ADR 0025 refuse as dependencies. Its
disciplines, however, are worth distilling: provenance on every edge,
"coverage must close end to end, partial coverage is worse than none"
enforced by probe traces, per-app route tables, and a relevance-weighted
budget for what the agent is shown.

## Decision

1. **The survey graph is deepened in place, not replaced.** `SurveyNode` gains
   `id`, `kind` (`file` for today's nodes), `label`, `lineStart`/`lineEnd`,
   `attrs`, `origin`, `descriptor` and `anchor`; `SurveyEdge` gains `origin`
   (`scanner | llm | external`), `confidence` (`exact | inferred`), `rule`
   (the pack section that produced it), `mechanism` (`capture | join:exact |
join:url | contraction | llm | codegraph`), `join` and `evidence`;
   `SurveyGraph` gains `unresolved` and `fills`. Every new field has a
   decoding default, so a `graph.json` written before this ADR decodes. A
   node's id is `<kind>:<path>#<name>` (file nodes keep their unit name as
   id); duplicates within a file get `~2`, `~3` in rule order.
2. **Packs declare the vocabulary, declaratively.** Four new section kinds
   join `## Survey:` in `pack.md`:
   - `## Node: <kind>` — `files:`, a `pattern:` whose `(?<name>…)` group names
     the node and whose other named groups become `attrs`; optional
     `descriptor: yes` (a wiring record, not a unit of the estate), `anchor:
<attr>` (the unit the node stands for) and `attrs: a=b` copies.
   - `## Edge: <kind>` — `files:`, a `pattern:` with a `(?<to>…)` group and
     an optional `(?<thru>…)` group for ranges, `from: <node kind>` (the
     enclosing node of that kind; default `file`) and `to: <node kind>`
     (resolved in the same file first; default `file`, today's unit-name
     resolution). `## Survey: <name>` is exactly an `## Edge:` with both
     defaults and keeps working unchanged.
   - `## Join: <kind>` — `from: <kind>.<attr>`, `to: <kind>.<attr>`,
     `match: exact | url`, `scope: estate | app | file`. `url` matching
     normalises both sides (scheme, host, `${…}`/`<%=…%>` prefixes, query,
     fragment and trailing slash removed) and then applies servlet-spec
     order: exact, longest `/*` prefix, `*.ext`; the edge records which. The
     default scope of a `url` join is `app`: the nearest ancestor directory
     containing `WEB-INF`, else the estate.
   - `## Probe: <name>` — `from:` and `to:` node references (an id, or
     `<kind>:<name>` resolved by name) that must be connected by a path.
     Probes are the pack's canonical flows; pack-check fails when one is
     broken, and the bank's hand-extracted flows become probes in its pack.
   - `## Graph` — `worklist-max:` (default 200) and `batch-size:` (default 20)
     for the LLM pass.
     There are no TypeScript extractors. `## Consolidate` may name Edge and
     Join kinds as well as Survey kinds.
3. **File projection keeps every existing consumer working.** `closureFor`
   and `clusterPrograms` operate on `projectToFiles(graph)`: each node folds
   onto a unit (its `anchor` attr when it names a known unit, else its file),
   descriptor nodes with outgoing edges are contracted so `page → mapping →
decl → servlet` becomes `page → servlet` under the page edge's kind, self
   loops are dropped. On a graph without sub-file nodes the projection is the
   identity.
4. **Extraction is hybrid, deterministic first.** The scanner pass produces
   every node and every exact edge. What it cannot resolve becomes a typed
   `unresolved` list: an edge capture whose target has no node, a join source
   with no outgoing join edge or without the attr the join needs, a join
   target nothing reaches, and a file node of degree zero. The LLM pass works
   that list in batches, highest-degree nodes first, on the read-only analyst
   seat. It may **fill an attr** or **add an edge between two existing
   nodes**; it may not create nodes. Each answer carries `file`, `line` and
   the quoted `snippet`; an item whose snippet is not found within two lines
   of the stated line, or whose endpoints do not exist, is dropped and
   counted. Accepted edges carry `origin: llm, confidence: inferred,
mechanism: llm`; joins recomputed over an LLM-filled attr carry the same
   origin. `LLM4TS_GRAPH_REFINE=off` skips the pass as before.
5. **The graph is distilled into a cache, never a dependency.** The built
   graph lives at `.llm4ts/graph/<pack>.json` with
   `meta {version, pack, rulesHash, rev, builtAt, files: {path: sha256}}`.
   `docs/modernization/graph.json` and `graph.dot` remain the committed,
   human-facing exports. Staleness is decided by content, not by revision:
   when the rule hash and every file hash match, the cache is used; otherwise
   the scanner layer is rebuilt and the LLM and external contributions whose
   evidence file is unchanged are carried over, re-joined and re-verified
   against the new node set. Extract, refine and the kit convert flow read
   the graph this way, so LLM edges reach the analyst's closure.
6. **An external symbol index may feed the graph, never replace it.**
   `origin: external` with `mechanism: codegraph` is reserved for an adapter
   that imports Java call edges and COBOL `PERFORM` edges from a codegraph
   database when that tool is installed, probed and never required, the way
   CLI connectors are. The adapter is not built here; it waits for a probe on
   the bank estate that regex cannot close.
7. **Queries and renders are pure functions in `@llm4ts/flow`.** `searchNodes`
   (lexical, with a co-location boost for nodes sharing a file with a strong
   hit), `neighborhood`, `shortestPath` (bidirectional), `closureView` and
   `graphStats` (per kind, per origin, per mechanism, unresolved by reason);
   `renderGraphMermaid`, `renderGraphDot`, `renderGraphText` over one view
   model (nodes grouped by file, edge labelled by kind, dotted when inferred,
   red when unresolved, the id in a trailing comment). Mermaid refuses a view
   above 150 nodes unless forced and degrades to the text list.
   `llm4ts graph build | query | path | closure | stats | probe` is a thin
   runner program over them (`--format text|json|mermaid|dot`). The CLI build
   is the scanner pass; the LLM pass runs in `modernize-survey`.
8. **Flows change where they lose information today.** Survey writes the
   inventory with one mermaid block per consolidate cluster and an entry-path
   section; extract prepends the program's closure diagram to each spec;
   pack-check reports every Node, Edge and Join rule's matches, duplicate
   names, the unresolved list and the probe verdicts, so a rule is debugged
   without a model. The analyst's closure becomes spine-first: files on a
   probe or join path from the program rank ahead of the rest and the
   context budget is spent in that order, with the remainder listed as paths
   only. That last change ships after the graph, measured with `llm4ts
profile` on an extract run.

## Consequences

- A pack that declares only `## Survey:` rules produces, byte for byte, the
  file graph it produced before; the smoke tests that decode `graph.json`
  with the real schema continue to pass.
- The LLM pass is bounded by `worklist-max` items instead of the estate, and
  every accepted contribution is tied to a source line that is re-checked on
  each rebuild.
- `## Consolidate` validation accepts Edge and Join kinds; the j2ee pack's
  `jsp-ajax-target` becomes a Join of the same name, so its cluster rule is
  unchanged.
- The cobol packs gain `SECTION` nodes, `GO TO` edges and `PERFORM … THRU`
  range expansion alongside paragraphs and `PERFORM`.
- The release gate is deterministic: the bank pack's probes pass in
  pack-check after the scanner pass for at least 80 percent of the
  hand-extracted flows and after the LLM pass for at least 95 percent of
  their named nodes; the verdict per probe is printed, not scripted.
- `llm4zio` has no counterpart; this ADR is the parity note.

## Not decided here

A graph of the target repository for `epic-stories`; a seat-callable graph
tool (MCP or function-calling), with the session dedup and named-chain path
mode a coder seat would want; the codegraph import adapter itself;
TypeScript extractors in kits; an ESB call node rule (waits on the estate's
wrapper pattern); incremental rescans of only changed files; a file watcher.
