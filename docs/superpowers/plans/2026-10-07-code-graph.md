# Code Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the survey graph into a code graph with sub-file nodes, declarative joins, probes, a hybrid LLM worklist, a content-hashed cache, queries, renders and a `llm4ts graph` verb, so the modernize flows stop losing graph information.

**Architecture:** `packages/flow/src/Survey.ts` is generalised in place (optional fields with helpers, so every existing caller compiles); new flow modules `GraphRules.ts`, `GraphCache.ts`, `GraphWorklist.ts`, `GraphQuery.ts`, `GraphRender.ts` are pure functions over `SurveyGraph`; `Pack.ts` parses the new sections; a runner program `Graph.ts` and a shell verb expose it; the modernize flows and the j2ee convert flow read the graph through `freshGraph`.

**Tech Stack:** TypeScript, Effect 4.0.0 (exact pin), `effect/Schema`, `@effect/vitest`, `effect/cli`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-code-graph-design.md` (decisions), `docs/adr/0030-code-graph.md` (record).

## Global Constraints

- `effect` and every `@effect/*` package stay pinned at exactly `4.0.0`; no new runtime dependency anywhere.
- Relative imports use `.ts` extensions; every new public module gets a subpath export in its package's `package.json` (`"./GraphRules": "./dist/GraphRules.js"` form).
- No `any`, no unchecked type assertions, no namespaces, no unmanaged promises; expected failures are existing `Schema.TaggedError`s (`PlanParseError`, `PersistenceError`, `WorkspaceError`, `FlowAborted`).
- Regex rules run with flags `gm`.
- A `graph.json` written before this change must decode with `SurveyGraph`; `SurveyNode.make({path, name, lines, units})`, `SurveyEdge.make({from, to, kind})` and `SurveyGraph.make({nodes, edges})` must keep compiling at every existing call site.
- A pack with only `## Survey:` rules must produce the same nodes and edges as before (plus `unresolved` entries).
- Tests are deterministic `@effect/vitest` tests; no network, no provider, no installed CLI.
- Secrets never appear in logs, traces or persisted graphs (the graph holds paths, names, attrs and snippets of source only).
- Verification before every commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Package versions move to `2.38.0` only in the final task, via `pnpm version:set 2.38.0`.

## Review Focus

1. A `web.xml` whose `<servlet-mapping>` carries two `<url-pattern>` elements: the rule captures the first only; the second URL must surface as a `join-from` unresolved on the ajax side, never as a wrong edge. Pinned in Task 4.
2. A `${ctx}`-prefixed relative ajax URL with a query string, and a `*.do` form action, must each join to the right mapping with `join: exact` and `join: extension`. Pinned in Task 4.
3. A v1 `graph.json` (nodes with only `path, name, lines, units`; edges with only `from, to, kind`) must decode and project to itself. Pinned in Task 1.
4. An LLM answer whose snippet is correct but three lines away from the stated line, or whose endpoint is an unknown unit literal, must be dropped and counted, never merged. Pinned in Task 6.
5. A cache built with different rules (same files) must be rebuilt, not reused; a cache whose LLM edge's evidence file changed must drop that edge and keep the others. Pinned in Task 5.

## File structure

| Path                                                                                                                                                                      | Responsibility                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/flow/src/Survey.ts` (modify)                                                                                                                                    | schemas + helpers, `projectToFiles`, `graphFromJson`, `buildCodeGraph`, `applyFillsAndJoins`, `surveyGraph` delegation, `closureFor` via projection |
| `packages/flow/src/GraphRules.ts` (create)                                                                                                                                | `NodeRule`, `EdgeRule`, `JoinRule`, `ProbeRule`, `GraphRules`, `parseGraphRules`, `graphRulesHash`, URL normaliser and matcher                      |
| `packages/flow/src/Pack.ts` (modify)                                                                                                                                      | `graph: GraphRules` on `Pack`; Consolidate validation over Edge and Join kinds                                                                      |
| `packages/flow/src/GraphCache.ts` (create)                                                                                                                                | cache envelope, `freshGraph`, carry-over of LLM/external contributions                                                                              |
| `packages/flow/src/GraphWorklist.ts` (create)                                                                                                                             | worklist, prompt, answer schema, verification, merge, report                                                                                        |
| `packages/flow/src/GraphQuery.ts` (create)                                                                                                                                | search, neighborhood, shortest path, closure view, stats, node refs, probes                                                                         |
| `packages/flow/src/GraphRender.ts` (create)                                                                                                                               | mermaid, dot, text, entry paths, cluster diagrams                                                                                                   |
| `packages/flow/src/Domains.ts` (modify)                                                                                                                                   | `clusterPrograms` projects first                                                                                                                    |
| `packages/flow/test/support/legacyMini.ts` (create)                                                                                                                       | the shared fixture estate and its pack manifest                                                                                                     |
| `packages/runner/src/Graph.ts` (create)                                                                                                                                   | `makeGraphProgram`, `nodeGraphDependencies`                                                                                                         |
| `packages/shell/src/Cli.ts` (modify)                                                                                                                                      | `graph` verb and subcommands                                                                                                                        |
| `flows/modernize-survey.ts`, `flows/modernize-extract.ts`, `flows/modernize-refine.ts`, `flows/modernize-pack-check.ts`, `kits/j2ee-nextjs/flows/lib/convert.ts` (modify) | read through `freshGraph`; worklist refine; diagrams; probe verdicts                                                                                |
| `kits/j2ee-nextjs/packs/*/pack.md`, `kits/mainframe-java/packs/cobol-*/pack.md` (modify)                                                                                  | Node/Edge/Join/Probe rules                                                                                                                          |
| `skills/authoring-llm4ts-packs/SKILL.md`, `CHANGELOG.md` (modify)                                                                                                         | docs                                                                                                                                                |

---

### Task 1: Schema deepening, helpers, projection, JSON loader

**Files:**

- Modify: `packages/flow/src/Survey.ts`
- Test: `packages/flow/test/CodeGraph.test.ts` (create)

**Interfaces:**

- Produces: `GraphOrigin`, `GraphConfidence`, `GraphMechanism`, `JoinMatch`, `GraphEvidence`, `Unresolved`, `Fill` schemas; optional fields on `SurveyNode`/`SurveyEdge`; `unresolved`/`fills` on `SurveyGraph`; helpers `nodeId`, `nodeKind`, `nodeLabel`, `nodeAttrs`, `nodeLineStart`, `nodeLineEnd`, `isDescriptor`, `edgeOrigin`, `edgeConfidence`; `projectToFiles(graph): SurveyGraph`; `graphFromJson(text): Effect<SurveyGraph, PlanParseError>`; `closureFor` unchanged in signature.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/flow/test/CodeGraph.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  SurveyEdge,
  SurveyGraph,
  SurveyNode,
  closureFor,
  graphFromJson,
  nodeId,
  nodeKind,
  projectToFiles
} from "@llm4ts/flow/Survey"

const fileNode = (name: string, path = `src/${name}.jsp`): SurveyNode =>
  SurveyNode.make({ path, name, lines: 10, units: 1 })

describe("code graph schema", () => {
  it.effect("decodes a v1 graph.json and projects it to itself", () =>
    Effect.gen(function* () {
      const v1 = JSON.stringify({
        nodes: [
          { path: "src/A.cbl", name: "A", lines: 3, units: 1 },
          { path: "src/B.cbl", name: "B", lines: 3, units: 1 }
        ],
        edges: [{ from: "A", to: "B", kind: "calls" }]
      })
      const graph = yield* graphFromJson(v1)
      assert.deepStrictEqual(graph.nodes.map(nodeId), ["A", "B"])
      assert.deepStrictEqual(graph.nodes.map(nodeKind), ["file", "file"])
      assert.deepStrictEqual(graph.unresolved, [])
      assert.deepStrictEqual(graph.fills, [])
      const projected = projectToFiles(graph)
      assert.deepStrictEqual(
        projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`),
        ["A->B:calls"]
      )
      assert.deepStrictEqual(closureFor(graph, "A", 10), ["src/B.cbl"])
    })
  )

  it("still constructs with the four original node fields", () => {
    const graph = SurveyGraph.make({
      nodes: [fileNode("a"), fileNode("b")],
      edges: [SurveyEdge.make({ from: "a", to: "b", kind: "jsp-include" })]
    })
    assert.strictEqual(graph.unresolved.length, 0)
    assert.strictEqual(nodeId(graph.nodes[0]!), "a")
  })

  it("contracts descriptor nodes and folds anchored nodes onto their unit", () => {
    const page = fileNode("fattura", "web/fattura.jsp")
    const servlet = fileNode("InvoiceServlet", "src/InvoiceServlet.java")
    const web = fileNode("web", "web/WEB-INF/web.xml")
    const ajax = SurveyNode.make({
      path: "web/fattura.jsp",
      name: "/salvaFattura",
      lines: 10,
      units: 0,
      id: "ajax-call:web/fattura.jsp#/salvaFattura",
      kind: "ajax-call",
      attrs: { url: "/salvaFattura" }
    })
    const mapping = SurveyNode.make({
      path: "web/WEB-INF/web.xml",
      name: "invoice",
      lines: 10,
      units: 0,
      id: "servlet-mapping:web/WEB-INF/web.xml#invoice",
      kind: "servlet-mapping",
      attrs: { url: "/salvaFattura" },
      descriptor: true
    })
    const decl = SurveyNode.make({
      path: "web/WEB-INF/web.xml",
      name: "invoice",
      lines: 10,
      units: 0,
      id: "servlet-decl:web/WEB-INF/web.xml#invoice",
      kind: "servlet-decl",
      attrs: { class: "InvoiceServlet" },
      descriptor: true,
      anchor: "class"
    })
    const graph = SurveyGraph.make({
      nodes: [page, servlet, web, ajax, mapping, decl],
      edges: [
        SurveyEdge.make({
          from: nodeId(ajax),
          to: nodeId(mapping),
          kind: "jsp-ajax-target",
          mechanism: "join:url"
        }),
        SurveyEdge.make({
          from: nodeId(mapping),
          to: nodeId(decl),
          kind: "servlet-wiring",
          mechanism: "join:exact"
        })
      ]
    })
    const projected = projectToFiles(graph)
    assert.deepStrictEqual(projected.nodes.map(nodeId).sort(), ["InvoiceServlet", "fattura", "web"])
    assert.deepStrictEqual(
      projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}:${edge.mechanism}`),
      ["fattura->InvoiceServlet:jsp-ajax-target:contraction"]
    )
    assert.deepStrictEqual(closureFor(graph, "fattura", 10), ["src/InvoiceServlet.java"])
  })

  it("encodes new fields and round-trips through the schema", () => {
    const edge = SurveyEdge.make({
      from: "a",
      to: "b",
      kind: "k",
      origin: "llm",
      confidence: "inferred",
      mechanism: "llm",
      evidence: { file: "src/a.js", line: 4, snippet: "x" }
    })
    const decoded = Schema.decodeUnknownSync(SurveyEdge)(JSON.parse(JSON.stringify(edge)))
    assert.strictEqual(decoded.origin, "llm")
    assert.strictEqual(decoded.evidence?.line, 4)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts`
Expected: FAIL — `graphFromJson`, `nodeId`, `projectToFiles` are not exported.

- [ ] **Step 3: Extend the schemas and add the helpers**

In `packages/flow/src/Survey.ts`, replace the three class declarations with:

```ts
import { PlanParseError } from "./FlowError.ts"

export const GraphOrigin = Schema.Literals(["scanner", "llm", "external"])
export type GraphOrigin = typeof GraphOrigin.Type
export const GraphConfidence = Schema.Literals(["exact", "inferred"])
export type GraphConfidence = typeof GraphConfidence.Type
export const GraphMechanism = Schema.Literals([
  "capture",
  "join:exact",
  "join:url",
  "contraction",
  "llm",
  "codegraph"
])
export type GraphMechanism = typeof GraphMechanism.Type
export const JoinMatch = Schema.Literals(["exact", "prefix", "extension"])
export type JoinMatch = typeof JoinMatch.Type

export class GraphEvidence extends Schema.Class<GraphEvidence>("GraphEvidence")({
  file: Schema.String,
  line: Schema.Int,
  snippet: Schema.String
}) {}

export class SurveyNode extends Schema.Class<SurveyNode>("SurveyNode")({
  path: Schema.String,
  name: Schema.String,
  lines: Schema.Int,
  units: Schema.Int,
  // ADR 0030: optional on the wire so a v1 graph.json decodes and the
  // four-field constructor keeps compiling; read through the helpers below.
  id: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  lineStart: Schema.optionalKey(Schema.Int),
  lineEnd: Schema.optionalKey(Schema.Int),
  attrs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  origin: Schema.optionalKey(GraphOrigin),
  descriptor: Schema.optionalKey(Schema.Boolean),
  anchor: Schema.optionalKey(Schema.String)
}) {}

export class SurveyEdge extends Schema.Class<SurveyEdge>("SurveyEdge")({
  from: Schema.String,
  to: Schema.String,
  kind: Schema.String,
  origin: Schema.optionalKey(GraphOrigin),
  confidence: Schema.optionalKey(GraphConfidence),
  rule: Schema.optionalKey(Schema.String),
  mechanism: Schema.optionalKey(GraphMechanism),
  join: Schema.optionalKey(JoinMatch),
  evidence: Schema.optionalKey(GraphEvidence)
}) {}

export const UnresolvedReason = Schema.Literals([
  "edge-target",
  "missing-attr",
  "join-from",
  "join-to",
  "isolated"
])
export type UnresolvedReason = typeof UnresolvedReason.Type

export class Unresolved extends Schema.Class<Unresolved>("Unresolved")({
  reason: UnresolvedReason,
  rule: Schema.String,
  node: Schema.String,
  reference: Schema.optionalKey(Schema.String),
  file: Schema.String,
  line: Schema.Int
}) {}

export class Fill extends Schema.Class<Fill>("Fill")({
  node: Schema.String,
  key: Schema.String,
  value: Schema.String,
  evidence: GraphEvidence
}) {}

const emptyList = <A>(schema: Schema.Codec<A>) =>
  Schema.Array(schema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([]))
  )

export class SurveyGraph extends Schema.Class<SurveyGraph>("SurveyGraph")({
  nodes: Schema.Array(SurveyNode),
  edges: Schema.Array(SurveyEdge),
  unresolved: emptyList(Unresolved),
  fills: emptyList(Fill)
}) {
  incoming(id: string): ReadonlyArray<SurveyEdge> {
    return this.edges.filter((edge) => edge.to === id)
  }
  outgoing(id: string): ReadonlyArray<SurveyEdge> {
    return this.edges.filter((edge) => edge.from === id)
  }
  node(id: string): SurveyNode | undefined {
    return this.nodes.find((node) => nodeId(node) === id)
  }
}

export const nodeId = (node: SurveyNode): string => node.id ?? node.name
export const nodeKind = (node: SurveyNode): string => node.kind ?? "file"
export const nodeLabel = (node: SurveyNode): string => node.label ?? node.name
export const nodeAttrs = (node: SurveyNode): Readonly<Record<string, string>> => node.attrs ?? {}
export const nodeLineStart = (node: SurveyNode): number => node.lineStart ?? 1
export const nodeLineEnd = (node: SurveyNode): number => node.lineEnd ?? node.lines
export const isDescriptor = (node: SurveyNode): boolean => node.descriptor === true
export const edgeOrigin = (edge: SurveyEdge): GraphOrigin => edge.origin ?? "scanner"
export const edgeConfidence = (edge: SurveyEdge): GraphConfidence => edge.confidence ?? "exact"
```

If `withConstructorDefault` refuses to compose after `withDecodingDefaultKey` (a type error on `emptyList`), apply `withConstructorDefault` first and `withDecodingDefaultKey` second; if neither order compiles, use `Schema.optionalKey(Schema.Array(...))` and add `unresolvedOf(graph) = graph.unresolved ?? []` and `fillsOf(graph) = graph.fills ?? []` helpers, using them wherever this plan reads `graph.unresolved` or `graph.fills`.

- [ ] **Step 4: Add `projectToFiles` and `graphFromJson`, route `closureFor` through the projection**

Add after the helpers:

```ts
/**
 * The file-level view every pre-ADR-0030 consumer expects. Each node folds onto
 * a unit (its `anchor` attr when that names a known unit, else its file's
 * unit); descriptor nodes with outgoing edges are contracted (`a → d → b`
 * becomes `a → b` under `a → d`'s kind); self loops drop; duplicates by
 * (from, to, kind) drop. On a file-only graph this is the identity.
 */
export const projectToFiles = (graph: SurveyGraph): SurveyGraph => {
  const files = graph.nodes.filter((node) => nodeKind(node) === "file")
  const known = new Set(files.map((node) => node.name))
  const byId = new Map(graph.nodes.map((node) => [nodeId(node), node]))
  const unitOf = (id: string): string => {
    const node = byId.get(id)
    if (node === undefined) {
      return id
    }
    if (nodeKind(node) === "file") {
      return node.name
    }
    const anchored = node.anchor === undefined ? undefined : nodeAttrs(node)[node.anchor]
    if (anchored !== undefined) {
      const resolved = resolveUnit(anchored, known)
      if (known.has(resolved)) {
        return resolved
      }
    }
    return unitName(node.path)
  }
  const contractible = new Set(
    graph.nodes
      .filter((node) => isDescriptor(node) && graph.outgoing(nodeId(node)).length > 0)
      .map(nodeId)
  )
  let edges: ReadonlyArray<SurveyEdge> = graph.edges
  for (let round = 0; round <= graph.nodes.length; round += 1) {
    const pending = edges.filter((edge) => contractible.has(edge.to))
    if (pending.length === 0) {
      break
    }
    edges = edges.flatMap((edge) =>
      !contractible.has(edge.to)
        ? [edge]
        : graph.outgoing(edge.to).map(
            (next) =>
              new SurveyEdge({
                ...edge,
                to: next.to,
                mechanism: "contraction",
                ...(edgeConfidence(edge) === "inferred" || edgeConfidence(next) === "inferred"
                  ? { confidence: "inferred" as const }
                  : {})
              })
          )
    )
  }
  const seen = new Set<string>()
  const projected = edges.flatMap((edge) => {
    if (contractible.has(edge.from)) {
      return []
    }
    const from = unitOf(edge.from)
    const to = unitOf(edge.to)
    const key = `${from}\u0000${to}\u0000${edge.kind}`
    if (from === to || seen.has(key)) {
      return []
    }
    seen.add(key)
    return [new SurveyEdge({ ...edge, from, to })]
  })
  return new SurveyGraph({
    nodes: files,
    edges: projected,
    unresolved: graph.unresolved,
    fills: graph.fills
  })
}

export const graphFromJson = (text: string): Effect.Effect<SurveyGraph, PlanParseError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (error) => PlanParseError.make({ message: `graph.json is not JSON: ${String(error)}` })
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(SurveyGraph)(json).pipe(
        Effect.mapError((error) =>
          PlanParseError.make({ message: `graph.json does not decode: ${String(error)}` })
        )
      )
    )
  )
```

In `closureFor`, replace the first line with `const projected = projectToFiles(graph)` and use `projected` for `pathOf` and `outgoing`. Keep the rest unchanged.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts packages/flow/test/ReviewSurvey.test.ts packages/flow/test/Domains.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the whole repo (kits and flows construct these classes)**

Run: `pnpm typecheck`
Expected: PASS with no edits elsewhere. If a call site breaks on `unresolved`/`fills`, apply the fallback in Step 3.

- [ ] **Step 7: Commit**

```bash
git add packages/flow/src/Survey.ts packages/flow/test/CodeGraph.test.ts
git commit -m "flow: survey graph carries sub-file nodes, provenance and a file projection (ADR 0030)"
```

---

### Task 2: Graph rule schemas and pack parsing

**Files:**

- Create: `packages/flow/src/GraphRules.ts`
- Modify: `packages/flow/src/Pack.ts`, `packages/flow/package.json` (add `"./GraphRules": "./dist/GraphRules.js"`)
- Test: `packages/flow/test/GraphRules.test.ts` (create), `packages/flow/test/Pack.test.ts` (add one case)

**Interfaces:**

- Produces:
  ```ts
  class NodeRule {
    kind
    files
    pattern
    descriptor: boolean
    anchor?: string
    attrs: Record<string, string>
  }
  class EdgeRule {
    kind
    files
    pattern
    fromKind: string
    toKind: string
  }
  class JoinRule {
    kind
    fromKind
    fromAttr
    toKind
    toAttr
    match: "exact" | "url"
    scope: "estate" | "app" | "file"
  }
  class ProbeRule {
    name
    from
    to
  }
  interface GraphRules {
    nodes
    edges
    joins
    probes
    worklistMax: number
    batchSize: number
  }
  const emptyGraphRules: GraphRules
  const edgeRuleOfSurvey: (rule: CoverageRule) => EdgeRule
  const parseGraphRules: (
    sections: ReadonlyArray<string>,
    survey: ReadonlyArray<CoverageRule>
  ) => Effect<GraphRules, PlanParseError>
  const graphRulesHash: (rules: GraphRules) => string
  const normalizeUrl: (raw: string) => string
  const matchUrl: (request: string, pattern: string) => JoinMatch | undefined
  const edgeKindsOf: (rules: GraphRules) => ReadonlySet<string> // edge kinds + join kinds
  ```
- `Pack` gains `readonly graph: GraphRules`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/flow/test/GraphRules.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { CoverageRule } from "@llm4ts/flow/SpecChecks"
import {
  edgeKindsOf,
  graphRulesHash,
  matchUrl,
  normalizeUrl,
  parseGraphRules
} from "@llm4ts/flow/GraphRules"

const sections = (markdown: string): ReadonlyArray<string> =>
  markdown
    .trim()
    .split(/^(?=## )/m)
    .map((chunk) => chunk.trim())
    .filter((c) => c.length > 0)

const manifest = `## Node: servlet-mapping
files: .*web\\.xml
pattern: <servlet-mapping>\\s*<servlet-name>(?<name>[^<]+)</servlet-name>\\s*<url-pattern>(?<url>[^<]+)</url-pattern>
descriptor: yes

## Node: ajax-call
files: .*\\.(js|jsp)
pattern: url:\\s*['"](?<name>[^'"]+)['"]
attrs: url=name

## Edge: performs
files: .*\\.cbl
pattern: PERFORM +(?<to>\\d{4}-[A-Z0-9-]+)(?: +THRU +(?<thru>\\d{4}-[A-Z0-9-]+))?
from: cobol-paragraph
to: cobol-paragraph

## Join: jsp-ajax-target
from: ajax-call.url
to: servlet-mapping.url
match: url

## Probe: save-invoice
from: file:fattura
to: file:InvoiceServlet

## Graph
- worklist-max: 50
- batch-size: 5
`

describe("graph rules", () => {
  it.effect("parses node, edge, join, probe and graph sections and folds survey rules in", () =>
    Effect.gen(function* () {
      const survey = [
        CoverageRule.make({ name: "calls", files: ".*\\.cbl", unit: "CALL '([A-Z0-9]+)'" })
      ]
      const rules = yield* parseGraphRules(sections(manifest), survey)
      assert.deepStrictEqual(
        rules.nodes.map((rule) => rule.kind),
        ["servlet-mapping", "ajax-call"]
      )
      assert.strictEqual(rules.nodes[0]?.descriptor, true)
      assert.deepStrictEqual(rules.nodes[1]?.attrs, { url: "name" })
      assert.deepStrictEqual(
        rules.edges.map((rule) => `${rule.kind}:${rule.fromKind}>${rule.toKind}`),
        ["calls:file>file", "performs:cobol-paragraph>cobol-paragraph"]
      )
      assert.strictEqual(rules.edges[0]?.pattern, "CALL '(?<to>[A-Z0-9]+)'")
      assert.deepStrictEqual(rules.joins[0], {
        kind: "jsp-ajax-target",
        fromKind: "ajax-call",
        fromAttr: "url",
        toKind: "servlet-mapping",
        toAttr: "url",
        match: "url",
        scope: "app"
      })
      assert.deepStrictEqual(rules.probes, [
        { name: "save-invoice", from: "file:fattura", to: "file:InvoiceServlet" }
      ])
      assert.strictEqual(rules.worklistMax, 50)
      assert.strictEqual(rules.batchSize, 5)
      assert.deepStrictEqual([...edgeKindsOf(rules)].sort(), [
        "calls",
        "jsp-ajax-target",
        "performs"
      ])
      assert.strictEqual(
        graphRulesHash(rules),
        graphRulesHash(yield* parseGraphRules(sections(manifest), survey))
      )
    })
  )

  it.effect(
    "rejects a node pattern without a name group, an edge without a to group, and a join on an undeclared kind",
    () =>
      Effect.gen(function* () {
        const bad = (body: string) =>
          parseGraphRules(sections(body), []).pipe(
            Effect.flip,
            Effect.map((error) => error.message)
          )
        assert.include(yield* bad("## Node: x\nfiles: .*\npattern: (?<url>a)\n"), "(?<name>")
        assert.include(yield* bad("## Edge: x\nfiles: .*\npattern: a\n"), "(?<to>")
        assert.include(yield* bad("## Join: x\nfrom: ghost.url\nto: ghost.url\n"), "ghost")
        assert.include(
          yield* bad("## Node: x\nfiles: .*\npattern: (?<name>[\n"),
          "not a valid regex"
        )
      })
  )

  it("normalises and matches URLs in servlet-spec order", () => {
    assert.strictEqual(normalizeUrl("${ctx}/salvaFattura?id=1"), "/salvaFattura")
    assert.strictEqual(normalizeUrl("<%=request.getContextPath()%>/a/b/"), "/a/b")
    assert.strictEqual(normalizeUrl("https://host:8080/app/x#frag"), "/app/x")
    assert.strictEqual(normalizeUrl("salvaFattura.do"), "/salvaFattura.do")
    assert.strictEqual(normalizeUrl("/"), "/")
    assert.strictEqual(matchUrl("/salvaFattura", "/salvaFattura"), "exact")
    assert.strictEqual(matchUrl("/api/report/monthly", "/api/*"), "prefix")
    assert.strictEqual(matchUrl("/salvaFattura.do", "*.do"), "extension")
    assert.strictEqual(matchUrl("/other", "/api/*"), undefined)
  })
})
```

Add to `packages/flow/test/Pack.test.ts`:

```ts
it.effect("exposes graph rules and lets Consolidate name Edge and Join kinds", () =>
  Effect.gen(function* () {
    const workspace = yield* makeMemoryWorkspace()
    yield* workspace.write(
      "pack/pack.md",
      [
        "# Pack: web",
        "",
        "source: jsp",
        "sources: .*",
        "",
        "## Node: form",
        "files: .*\\.jsp",
        'pattern: action="(?<name>[^"]+)"',
        "attrs: url=name",
        "",
        "## Node: mapping",
        "files: .*web\\.xml",
        "pattern: <url-pattern>(?<name>[^<]+)</url-pattern>",
        "attrs: url=name",
        "descriptor: yes",
        "",
        "## Join: jsp-form-action",
        "from: form.url",
        "to: mapping.url",
        "match: url",
        "",
        "## Consolidate",
        "- cluster: jsp-form-action",
        ""
      ].join("\n")
    )
    const pack = yield* loadPack(workspace, "pack")
    assert.strictEqual(pack.graph.joins.length, 1)
    assert.deepStrictEqual(pack.consolidate?.cluster, ["jsp-form-action"])
  })
)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/GraphRules.test.ts packages/flow/test/Pack.test.ts`
Expected: FAIL — module `@llm4ts/flow/GraphRules` not found; the Pack case fails on `## Consolidate` naming an unknown kind.

- [ ] **Step 3: Write `GraphRules.ts`**

```ts
// packages/flow/src/GraphRules.ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PlanParseError } from "./FlowError.ts"
import { fingerprintOf } from "./ReviewCache.ts"
import type { CoverageRule } from "./SpecChecks.ts"
import type { JoinMatch } from "./Survey.ts"

export class NodeRule extends Schema.Class<NodeRule>("NodeRule")({
  kind: Schema.String,
  files: Schema.String,
  pattern: Schema.String,
  descriptor: Schema.Boolean,
  anchor: Schema.optionalKey(Schema.String),
  attrs: Schema.Record(Schema.String, Schema.String)
}) {}

export class EdgeRule extends Schema.Class<EdgeRule>("EdgeRule")({
  kind: Schema.String,
  files: Schema.String,
  pattern: Schema.String,
  fromKind: Schema.String,
  toKind: Schema.String
}) {}

export const JoinMatchMode = Schema.Literals(["exact", "url"])
export const JoinScope = Schema.Literals(["estate", "app", "file"])

export class JoinRule extends Schema.Class<JoinRule>("JoinRule")({
  kind: Schema.String,
  fromKind: Schema.String,
  fromAttr: Schema.String,
  toKind: Schema.String,
  toAttr: Schema.String,
  match: JoinMatchMode,
  scope: JoinScope
}) {}

export class ProbeRule extends Schema.Class<ProbeRule>("ProbeRule")({
  name: Schema.String,
  from: Schema.String,
  to: Schema.String
}) {}

export interface GraphRules {
  readonly nodes: ReadonlyArray<NodeRule>
  readonly edges: ReadonlyArray<EdgeRule>
  readonly joins: ReadonlyArray<JoinRule>
  readonly probes: ReadonlyArray<ProbeRule>
  readonly worklistMax: number
  readonly batchSize: number
}

export const emptyGraphRules: GraphRules = {
  nodes: [],
  edges: [],
  joins: [],
  probes: [],
  worklistMax: 200,
  batchSize: 20
}

/** `## Survey:` is an Edge rule between files whose first capture is the target. */
export const edgeRuleOfSurvey = (rule: CoverageRule): EdgeRule =>
  EdgeRule.make({
    kind: rule.name,
    files: rule.files,
    pattern: rule.unit.includes("(?<to>") ? rule.unit : rule.unit.replace("(", "(?<to>"),
    fromKind: "file",
    toKind: "file"
  })

const fail = (message: string) => Effect.fail(PlanParseError.make({ message }))

const isValidRegExp = (source: string): boolean => {
  try {
    new RegExp(source, "gm")
    return true
  } catch {
    return false
  }
}

const fieldsOf = (lines: ReadonlyArray<string>): Readonly<Record<string, string>> =>
  Object.fromEntries(
    lines.flatMap((line) => {
      const trimmed = line.replace(/^- /, "")
      const index = trimmed.indexOf(":")
      return index < 0 ? [] : [[trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim()]]
    })
  )

const yes = (value: string | undefined): boolean =>
  value !== undefined && ["yes", "true", "on"].includes(value.trim().toLowerCase())

export const parseGraphRules = (
  sections: ReadonlyArray<string>,
  survey: ReadonlyArray<CoverageRule>
): Effect.Effect<GraphRules, PlanParseError> =>
  Effect.gen(function* () {
    const nodes: Array<NodeRule> = []
    const edges: Array<EdgeRule> = survey.map(edgeRuleOfSurvey)
    const joins: Array<JoinRule> = []
    const probes: Array<ProbeRule> = []
    let worklistMax = emptyGraphRules.worklistMax
    let batchSize = emptyGraphRules.batchSize
    for (const section of sections) {
      const lines = section.split(/\r?\n/)
      const heading = lines[0]?.trim() ?? ""
      const fields = fieldsOf(lines.slice(1))
      if (heading.startsWith("## Node: ")) {
        const kind = heading.slice("## Node: ".length).trim()
        if (fields.files === undefined || fields.pattern === undefined) {
          return yield* fail(`'${heading}' needs 'files:' and 'pattern:'`)
        }
        if (!isValidRegExp(fields.pattern)) {
          return yield* fail(`'${heading}' pattern is not a valid regex: ${fields.pattern}`)
        }
        if (!fields.pattern.includes("(?<name>")) {
          return yield* fail(`'${heading}' pattern needs a (?<name>…) group`)
        }
        const attrs = Object.fromEntries(
          (fields.attrs ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
            .map((item) => item.split("=").map((part) => part.trim()))
            .flatMap((pair) =>
              pair.length === 2 && pair[0] && pair[1] ? [[pair[0], pair[1]]] : []
            )
        )
        nodes.push(
          NodeRule.make({
            kind,
            files: fields.files,
            pattern: fields.pattern,
            descriptor: yes(fields.descriptor),
            ...(fields.anchor === undefined ? {} : { anchor: fields.anchor }),
            attrs
          })
        )
      } else if (heading.startsWith("## Edge: ")) {
        const kind = heading.slice("## Edge: ".length).trim()
        if (fields.files === undefined || fields.pattern === undefined) {
          return yield* fail(`'${heading}' needs 'files:' and 'pattern:'`)
        }
        if (!isValidRegExp(fields.pattern)) {
          return yield* fail(`'${heading}' pattern is not a valid regex: ${fields.pattern}`)
        }
        if (!fields.pattern.includes("(?<to>")) {
          return yield* fail(`'${heading}' pattern needs a (?<to>…) group`)
        }
        edges.push(
          EdgeRule.make({
            kind,
            files: fields.files,
            pattern: fields.pattern,
            fromKind: fields.from ?? "file",
            toKind: fields.to ?? "file"
          })
        )
      } else if (heading.startsWith("## Join: ")) {
        const kind = heading.slice("## Join: ".length).trim()
        const [fromKind, fromAttr] = (fields.from ?? "").split(".")
        const [toKind, toAttr] = (fields.to ?? "").split(".")
        if (!fromKind || !fromAttr || !toKind || !toAttr) {
          return yield* fail(`'${heading}' needs 'from: <kind>.<attr>' and 'to: <kind>.<attr>'`)
        }
        const match = fields.match === "url" ? "url" : "exact"
        const scope =
          fields.scope === "file" || fields.scope === "app" || fields.scope === "estate"
            ? fields.scope
            : match === "url"
              ? "app"
              : "estate"
        joins.push(JoinRule.make({ kind, fromKind, fromAttr, toKind, toAttr, match, scope }))
      } else if (heading.startsWith("## Probe: ")) {
        const name = heading.slice("## Probe: ".length).trim()
        if (fields.from === undefined || fields.to === undefined) {
          return yield* fail(`'${heading}' needs 'from:' and 'to:'`)
        }
        probes.push(ProbeRule.make({ name, from: fields.from, to: fields.to }))
      } else if (heading === "## Graph") {
        const max = Number.parseInt(fields["worklist-max"] ?? "", 10)
        const batch = Number.parseInt(fields["batch-size"] ?? "", 10)
        worklistMax = Number.isInteger(max) && max > 0 ? max : worklistMax
        batchSize = Number.isInteger(batch) && batch > 0 ? batch : batchSize
      }
    }
    const nodeKinds = new Set(["file", ...nodes.map((rule) => rule.kind)])
    for (const rule of edges) {
      for (const kind of [rule.fromKind, rule.toKind]) {
        if (!nodeKinds.has(kind)) {
          return yield* fail(
            `'## Edge: ${rule.kind}' names node kind '${kind}' no '## Node:' declares`
          )
        }
      }
    }
    for (const rule of joins) {
      for (const kind of [rule.fromKind, rule.toKind]) {
        if (!nodeKinds.has(kind)) {
          return yield* fail(
            `'## Join: ${rule.kind}' names node kind '${kind}' no '## Node:' declares`
          )
        }
      }
    }
    return { nodes, edges, joins, probes, worklistMax, batchSize }
  })

export const edgeKindsOf = (rules: GraphRules): ReadonlySet<string> =>
  new Set([...rules.edges.map((rule) => rule.kind), ...rules.joins.map((rule) => rule.kind)])

export const graphRulesHash = (rules: GraphRules): string =>
  fingerprintOf([JSON.stringify({ n: rules.nodes, e: rules.edges, j: rules.joins })])

/** `${ctx}/a/b?x=1` → `/a/b`; `salva.do` → `/salva.do`; host and fragment dropped. */
export const normalizeUrl = (raw: string): string => {
  let url = raw.trim()
  url = url.replace(/^(\$\{[^}]*\}|<%=[^%]*%>)/, "")
  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "")
  url = url.replace(/[?#].*$/, "")
  if (!url.startsWith("/")) {
    url = `/${url}`
  }
  if (url.length > 1 && url.endsWith("/")) {
    url = url.slice(0, -1)
  }
  return url
}

export const matchUrl = (request: string, pattern: string): JoinMatch | undefined => {
  const target = normalizeUrl(pattern)
  if (request === target) {
    return "exact"
  }
  if (target.endsWith("/*")) {
    const prefix = target.slice(0, -2)
    return request === prefix || request.startsWith(`${prefix}/`) ? "prefix" : undefined
  }
  if (pattern.trim().startsWith("*.")) {
    return request.endsWith(pattern.trim().slice(1)) ? "extension" : undefined
  }
  return undefined
}
```

Note: `normalizeUrl("*.do")` would prefix a slash, so `matchUrl` reads the raw pattern for the extension case, as written.

- [ ] **Step 4: Wire the pack**

In `packages/flow/src/Pack.ts`:

- import `{ emptyGraphRules, edgeKindsOf, parseGraphRules, type GraphRules } from "./GraphRules.ts"`;
- add `readonly graph: GraphRules` to `Pack` after `survey`;
- in `loadPack`, after `const survey = rules(manifest.sections, "## Survey: ")` (introduce that const and use it for the `survey:` field), add `const graph = yield* parseGraphRules(manifest.sections, survey)`;
- in the Consolidate validation replace `surveyNames` with `const knownKinds = new Set([...rules(manifest.sections, "## Survey: ").map((rule) => rule.name), ...edgeKindsOf(graph)])` and the message's "no '## Survey:' rule produces" with "no '## Survey:', '## Edge:' or '## Join:' rule produces";
- set `graph` on the returned pack.
- `emptyGraphRules` is unused in Pack.ts if every pack parses; keep the import out unless needed.

Add `"./GraphRules": "./dist/GraphRules.js"` to `packages/flow/package.json` exports, alphabetically after `"./GitTool"`.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/flow/test/GraphRules.test.ts packages/flow/test/Pack.test.ts kits/test/packs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/flow/src/GraphRules.ts packages/flow/src/Pack.ts packages/flow/package.json packages/flow/test/GraphRules.test.ts packages/flow/test/Pack.test.ts
git commit -m "flow: packs declare Node, Edge, Join, Probe and Graph sections (ADR 0030)"
```

---

### Task 3: The shared fixture estate and the scanner pass (nodes and edges)

**Files:**

- Create: `packages/flow/test/support/legacyMini.ts`
- Modify: `packages/flow/src/Survey.ts`
- Test: `packages/flow/test/CodeGraph.test.ts` (extend)

**Interfaces:**

- Consumes: `GraphRules`, `NodeRule`, `EdgeRule` from Task 2; schemas and helpers from Task 1.
- Produces:
  ```ts
  interface CodeGraphOptions {
    sources: string
    exclude?: string
    coverage: ReadonlyArray<CoverageRule>
    rules: GraphRules
  }
  interface CodeGraphBuild {
    graph: SurveyGraph
    files: Readonly<Record<string, string>>
  } // path → sha256
  const buildCodeGraph: (
    workspace: WorkspaceShape,
    options: CodeGraphOptions
  ) => Effect<CodeGraphBuild, WorkspaceError>
  const scanGraph: (paths, contents: ReadonlyMap<string, string>, options) => SurveyGraph // pure: nodes + captured edges, no joins
  ```
  `surveyGraph(...)` keeps its signature and delegates to `buildCodeGraph` with `rules = { ...emptyGraphRules, edges: edgeRules.map(edgeRuleOfSurvey) }`.
- Fixture exports `legacyMiniFiles: Readonly<Record<string, string>>`, `legacyMiniPackManifest: string`, `writeLegacyMini(workspace): Effect<void>` and `loadLegacyMiniPack(workspace): Effect<Pack>`.

- [ ] **Step 1: Write the fixture**

```ts
// packages/flow/test/support/legacyMini.ts
import * as Effect from "effect/Effect"
import { loadPack, type Pack } from "@llm4ts/flow/Pack"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"

export const legacyMiniFiles: Readonly<Record<string, string>> = {
  "web/fattura.jsp": [
    '<%@ page contentType="text/html" %>',
    '<jsp:include page="/web/header.jsp"/>',
    '<form action="salvaFattura.do" method="post"><input name="importo"/></form>',
    '<script src="js/invoice.js"></script>',
    ""
  ].join("\n"),
  "web/header.jsp": '<div class="header">Banca</div>\n',
  "web/js/invoice.js": [
    "$(function () {",
    "  $('#save').on('click', function () {",
    "    $.ajax({ url: '${ctx}/salvaFattura?id=' + id, type: 'POST' });",
    "  });",
    "  $.get('/api/report/monthly');",
    "  $.post(base + '/dynamic');",
    "});",
    ""
  ].join("\n"),
  "web/WEB-INF/web.xml": [
    "<web-app>",
    "  <servlet>",
    "    <servlet-name>invoice</servlet-name>",
    "    <servlet-class>com.legacy.InvoiceServlet</servlet-class>",
    "  </servlet>",
    "  <servlet>",
    "    <servlet-name>report</servlet-name>",
    "    <servlet-class>com.legacy.ReportServlet</servlet-class>",
    "  </servlet>",
    "  <servlet>",
    "    <servlet-name>orphan</servlet-name>",
    "    <servlet-class>com.legacy.OrphanServlet</servlet-class>",
    "  </servlet>",
    "  <servlet-mapping>",
    "    <servlet-name>invoice</servlet-name>",
    "    <url-pattern>/salvaFattura</url-pattern>",
    "  </servlet-mapping>",
    "  <servlet-mapping>",
    "    <servlet-name>report</servlet-name>",
    "    <url-pattern>/api/*</url-pattern>",
    "  </servlet-mapping>",
    "  <servlet-mapping>",
    "    <servlet-name>invoice</servlet-name>",
    "    <url-pattern>*.do</url-pattern>",
    "  </servlet-mapping>",
    "</web-app>",
    ""
  ].join("\n"),
  "src/com/legacy/InvoiceServlet.java": [
    "package com.legacy;",
    "public class InvoiceServlet extends HttpServlet {",
    "  protected void doPost(HttpServletRequest req, HttpServletResponse res) {",
    '    new EsbInvoiceService().call("SalvaFattura", req);',
    "  }",
    "}",
    ""
  ].join("\n"),
  "src/com/legacy/ReportServlet.java":
    "package com.legacy;\npublic class ReportServlet extends HttpServlet {}\n",
  "src/com/legacy/OrphanServlet.java":
    "package com.legacy;\npublic class OrphanServlet extends HttpServlet {}\n",
  "src/com/legacy/EsbInvoiceService.java": [
    "package com.legacy;",
    "public class EsbInvoiceService {",
    "  public Object call(String operation, Object request) { return null; }",
    "}",
    ""
  ].join("\n"),
  "cobol/ACCTXFR.cbl": [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. ACCTXFR.",
    "       PROCEDURE DIVISION.",
    "       MAIN-LOGIC SECTION.",
    "       0100-MAIN.",
    "           PERFORM 0200-VALIDATE THRU 0300-POST.",
    "           CALL 'FEECALC' USING WS-AMOUNT.",
    "       0200-VALIDATE.",
    "           PERFORM 9999-MISSING.",
    "       0250-CHECK.",
    "           GO TO 0300-POST.",
    "       0300-POST.",
    "           CALL 'AUDITLOG' USING WS-RECORD.",
    ""
  ].join("\n"),
  "cobol/FEECALC.cbl": [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. FEECALC.",
    "       PROCEDURE DIVISION.",
    "       0100-COMPUTE-FEE.",
    "           MOVE 1 TO WS-FEE.",
    ""
  ].join("\n")
}

export const legacyMiniPackManifest = `# Pack: legacy-mini

source: jsp
sources: .*\\.(jsp|js|java|xml|cbl)
programs: .*\\.(jsp|cbl)

## Coverage: cobol-paragraph

files: .*\\.cbl
unit: ^ {7}(\\d{4}-[A-Z0-9-]+)\\.

## Survey: jsp-include

files: .*\\.jsp
unit: <jsp:include page="([^"]+)"

## Node: ajax-call

files: .*\\.(js|jsp)
pattern: (?:url:\\s*|\\$\\.(?:get|post)\\(\\s*)['"](?<name>[^'"]+)['"]
attrs: url=name

## Node: ajax-dynamic

files: .*\\.js
pattern: \\$\\.(?:ajax|get|post)\\(\\s*(?<name>[A-Za-z_][A-Za-z0-9_.]*\\s*\\+\\s*['"][^'"]*['"])

## Node: form

files: .*\\.jsp
pattern: action="(?<name>[^"]+)"
attrs: url=name

## Node: servlet-mapping

files: .*web\\.xml
pattern: <servlet-mapping>\\s*<servlet-name>(?<name>[^<]+)</servlet-name>\\s*<url-pattern>(?<url>[^<]+)</url-pattern>
descriptor: yes

## Node: servlet-decl

files: .*web\\.xml
pattern: <servlet>\\s*<servlet-name>(?<name>[^<]+)</servlet-name>(?:(?!</servlet>)[\\s\\S])*?<servlet-class>(?:[a-z0-9_]+\\.)*(?<class>[A-Za-z0-9_]+)</servlet-class>
descriptor: yes
anchor: class

## Node: esb-call

files: .*\\.java
pattern: new Esb(?<service>[A-Za-z0-9]+)\\(\\)\\.call\\("(?<name>[A-Za-z0-9]+)"

## Node: cobol-section

files: .*\\.cbl
pattern: ^ {7}(?<name>[A-Z0-9][A-Z0-9-]*) +SECTION\\.

## Node: cobol-paragraph

files: .*\\.cbl
pattern: ^ {7}(?<name>\\d{4}-[A-Z0-9-]+)\\.

## Edge: performs

files: .*\\.cbl
pattern: PERFORM +(?<to>\\d{4}-[A-Z0-9-]+)(?: +THRU +(?<thru>\\d{4}-[A-Z0-9-]+))?
from: cobol-paragraph
to: cobol-paragraph

## Edge: goes-to

files: .*\\.cbl
pattern: GO +TO +(?<to>\\d{4}-[A-Z0-9-]+)
from: cobol-paragraph
to: cobol-paragraph

## Edge: calls

files: .*\\.cbl
pattern: CALL '(?<to>[A-Z0-9]+)'
from: cobol-paragraph

## Edge: invokes-esb

files: .*\\.java
pattern: \\.call\\("(?<to>[A-Za-z0-9]+)"
to: esb-call

## Join: jsp-ajax-target

from: ajax-call.url
to: servlet-mapping.url
match: url

## Join: jsp-ajax-target

from: ajax-dynamic.url
to: servlet-mapping.url
match: url

## Join: jsp-form-action

from: form.url
to: servlet-mapping.url
match: url

## Join: servlet-wiring

from: servlet-mapping.name
to: servlet-decl.name
scope: file

## Probe: save-invoice

from: fattura
to: esb-call:SalvaFattura

## Probe: monthly-report

from: invoice
to: ReportServlet

## Probe: orphan

from: fattura
to: OrphanServlet

## Consolidate

- cluster: jsp-ajax-target, jsp-form-action
- context: jsp-include

## Graph

- worklist-max: 10
- batch-size: 4
`

export const writeLegacyMini = (workspace: WorkspaceShape): Effect.Effect<void, unknown> =>
  Effect.forEach(Object.entries(legacyMiniFiles), ([path, text]) => workspace.write(path, text), {
    discard: true
  })

export const loadLegacyMiniPack = (workspace: WorkspaceShape): Effect.Effect<Pack, unknown> =>
  workspace
    .write("pack/pack.md", legacyMiniPackManifest)
    .pipe(Effect.andThen(loadPack(workspace, "pack")))
```

- [ ] **Step 2: Write the failing scanner tests**

Append to `packages/flow/test/CodeGraph.test.ts`:

```ts
import { buildCodeGraph, nodeAttrs, nodeLineStart, nodeLineEnd } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const built = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const build = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    coverage: pack.coverage,
    rules: pack.graph
  })
  return { workspace, pack, build, graph: build.graph }
})

describe("scanner pass", () => {
  it.effect("creates file nodes and sub-file nodes with stable ids, attrs and spans", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const ids = graph.nodes.map(nodeId)
      assert.include(ids, "fattura")
      assert.include(ids, "ajax-call:web/js/invoice.js#${ctx}/salvaFattura?id=")
      assert.include(ids, "ajax-call:web/js/invoice.js#/api/report/monthly")
      assert.include(ids, "ajax-dynamic:web/js/invoice.js#base + '/dynamic'")
      assert.include(ids, "form:web/fattura.jsp#salvaFattura.do")
      assert.include(ids, "servlet-mapping:web/WEB-INF/web.xml#invoice")
      assert.include(ids, "servlet-mapping:web/WEB-INF/web.xml#invoice~2")
      assert.include(ids, "servlet-decl:web/WEB-INF/web.xml#orphan")
      assert.include(ids, "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura")
      assert.include(ids, "cobol-section:cobol/ACCTXFR.cbl#MAIN-LOGIC")
      assert.include(ids, "cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN")
      const decl = graph.node("servlet-decl:web/WEB-INF/web.xml#invoice")!
      assert.deepStrictEqual(nodeAttrs(decl), { class: "InvoiceServlet" })
      assert.strictEqual(decl.descriptor, true)
      assert.strictEqual(decl.anchor, "class")
      const esb = graph.node("esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura")!
      assert.deepStrictEqual(nodeAttrs(esb), { service: "InvoiceService" })
      const main = graph.node("cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN")!
      assert.strictEqual(nodeLineStart(main), 5)
      assert.strictEqual(nodeLineEnd(main), 7)
      const file = graph.node("ACCTXFR")!
      assert.strictEqual(file.units, 4)
      assert.strictEqual(Object.keys((yield* built).build.files).length, 10)
    })
  )

  it.effect(
    "captures edges from the enclosing node, resolves targets same-file first, expands THRU, keeps file literals",
    () =>
      Effect.gen(function* () {
        const { graph } = yield* built
        const captured = graph.edges
          .filter((edge) => edge.mechanism === "capture")
          .map((edge) => `${edge.kind}:${edge.from}->${edge.to}`)
          .sort()
        assert.deepStrictEqual(captured, [
          "calls:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->FEECALC",
          "calls:cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST->AUDITLOG",
          "goes-to:cobol-paragraph:cobol/ACCTXFR.cbl#0250-CHECK->cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
          "invokes-esb:InvoiceServlet->esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura",
          "jsp-include:fattura->header",
          "performs:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->cobol-paragraph:cobol/ACCTXFR.cbl#0200-VALIDATE",
          "performs:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->cobol-paragraph:cobol/ACCTXFR.cbl#0250-CHECK",
          "performs:cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN->cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST"
        ])
        const performs = graph.edges.find((edge) => edge.kind === "performs")!
        assert.strictEqual(performs.rule, "performs")
        assert.strictEqual(performs.origin, "scanner")
        assert.strictEqual(performs.confidence, "exact")
        assert.strictEqual(performs.evidence?.line, 6)
        assert.include(performs.evidence?.snippet, "PERFORM 0200-VALIDATE THRU 0300-POST")
        const missing = graph.unresolved.filter((item) => item.reason === "edge-target")
        assert.deepStrictEqual(missing.map((item) => `${item.rule}:${item.reference}`).sort(), [
          "calls:AUDITLOG",
          "performs:9999-MISSING"
        ])
      })
  )

  it.effect("surveyGraph on Survey-only rules is unchanged", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(
        "legacy/A.cbl",
        "       0100-A.\n           CALL 'B'.\n           COPY CPY1.\n"
      )
      yield* workspace.write("legacy/B.cbl", "       0100-B.\n")
      const { CoverageRule } = yield* Effect.promise(() => import("@llm4ts/flow/SpecChecks"))
      const { surveyGraph } = yield* Effect.promise(() => import("@llm4ts/flow/Survey"))
      const graph = yield* surveyGraph(
        workspace,
        "\\.cbl$",
        [],
        [
          CoverageRule.make({ name: "calls", files: "\\.cbl$", unit: "CALL '([A-Z0-9]+)'" }),
          CoverageRule.make({ name: "copies", files: "\\.cbl$", unit: "COPY +([A-Z0-9]+)" })
        ]
      )
      assert.deepStrictEqual(
        graph.nodes.map((node) => node.name),
        ["A", "B"]
      )
      assert.deepStrictEqual(
        graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`),
        ["A->B:calls", "A->CPY1:copies"]
      )
    })
  )
})
```

Use plain static imports at the top of the file instead of the dynamic imports shown in the last test; they are written inline here only to keep the snippet self-contained.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts`
Expected: FAIL — `buildCodeGraph` is not exported.

- [ ] **Step 4: Implement the scanner pass in `Survey.ts`**

```ts
import { createHash } from "node:crypto"
import {
  edgeRuleOfSurvey,
  emptyGraphRules,
  type EdgeRule,
  type GraphRules,
  type NodeRule
} from "./GraphRules.ts"

export interface CodeGraphOptions {
  readonly sources: string
  readonly exclude?: string
  readonly coverage: ReadonlyArray<CoverageRule>
  readonly rules: GraphRules
}

export interface CodeGraphBuild {
  readonly graph: SurveyGraph
  /** path → sha256 of the scanned contents; the cache's staleness key. */
  readonly files: Readonly<Record<string, string>>
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

/** 0-based offset → 1-based line, via a precomputed table of line starts. */
const lineLocator = (text: string): ((offset: number) => number) => {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1)
    }
  }
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    return low + 1
  }
}

const lineText = (text: string, line: number): string => text.split(/\r?\n/)[line - 1] ?? ""

interface Captured {
  readonly rule: string
  readonly path: string
  readonly line: number
  readonly groups: Readonly<Record<string, string>>
}

const captures = (
  pattern: string,
  text: string,
  locate: (offset: number) => number
): ReadonlyArray<Omit<Captured, "rule" | "path">> =>
  [...text.matchAll(new RegExp(pattern, "gm"))].map((match) => ({
    line: locate(match.index ?? 0),
    groups: Object.fromEntries(
      Object.entries(match.groups ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]]
      )
    )
  }))

/** Node ids: `<kind>:<path>#<name>`, `~n` for a repeated name within one file. */
const scanNodes = (
  paths: ReadonlyArray<string>,
  contents: ReadonlyMap<string, string>,
  units: ReadonlyArray<CoverageRule>,
  rules: ReadonlyArray<NodeRule>
): ReadonlyArray<SurveyNode> => {
  const nodes: Array<SurveyNode> = []
  for (const path of paths) {
    const text = contents.get(path) ?? ""
    const lines = text.split(/\r?\n/).length
    nodes.push(
      SurveyNode.make({
        path,
        name: unitName(path),
        lines,
        units: units
          .filter((rule) => new RegExp(rule.files).test(path))
          .reduce((count, rule) => count + captures(rule.unit, text, () => 0).length, 0),
        id: unitName(path),
        kind: "file",
        lineStart: 1,
        lineEnd: lines
      })
    )
    const locate = lineLocator(text)
    for (const rule of rules.filter((rule) => new RegExp(rule.files).test(path))) {
      const found = captures(rule.pattern, text, locate)
      const seen = new Map<string, number>()
      const own: Array<SurveyNode> = []
      for (const hit of found) {
        const name = hit.groups.name ?? `L${hit.line}`
        const count = (seen.get(name) ?? 0) + 1
        seen.set(name, count)
        const attrs: Record<string, string> = Object.fromEntries(
          Object.entries(hit.groups).filter(([key]) => key !== "name")
        )
        for (const [attr, group] of Object.entries(rule.attrs)) {
          const value = hit.groups[group]
          if (value !== undefined) {
            attrs[attr] = value
          }
        }
        own.push(
          SurveyNode.make({
            path,
            name,
            lines: 0,
            units: 0,
            id: `${rule.kind}:${path}#${name}${count > 1 ? `~${count}` : ""}`,
            kind: rule.kind,
            label: name,
            lineStart: hit.line,
            lineEnd: lines,
            attrs,
            origin: "scanner",
            descriptor: rule.descriptor,
            ...(rule.anchor === undefined ? {} : { anchor: rule.anchor })
          })
        )
      }
      // A node spans to the line before the next node of the same kind in the file.
      own.forEach((node, index) => {
        const next = own[index + 1]
        nodes.push(
          next === undefined
            ? node
            : new SurveyNode({
                ...node,
                lineEnd: Math.max(nodeLineStart(node), nodeLineStart(next) - 1)
              })
        )
      })
    }
  }
  return nodes
}

const enclosing = (
  nodes: ReadonlyArray<SurveyNode>,
  path: string,
  kind: string,
  line: number
): SurveyNode | undefined =>
  nodes
    .filter((node) => node.path === path && nodeKind(node) === kind && nodeLineStart(node) <= line)
    .sort((left, right) => nodeLineStart(right) - nodeLineStart(left))[0]

const resolveTarget = (
  nodes: ReadonlyArray<SurveyNode>,
  known: ReadonlySet<string>,
  path: string,
  kind: string,
  reference: string
): { readonly id: string; readonly found: boolean } => {
  if (kind === "file") {
    const unit = resolveUnit(reference, known)
    return { id: unit, found: known.has(unit) }
  }
  const sameFile = nodes.find(
    (node) => node.path === path && nodeKind(node) === kind && node.name === reference
  )
  const anywhere =
    sameFile ?? nodes.find((node) => nodeKind(node) === kind && node.name === reference)
  return anywhere === undefined
    ? { id: reference, found: false }
    : { id: nodeId(anywhere), found: true }
}

const scanEdges = (
  paths: ReadonlyArray<string>,
  contents: ReadonlyMap<string, string>,
  nodes: ReadonlyArray<SurveyNode>,
  rules: ReadonlyArray<EdgeRule>
): {
  readonly edges: ReadonlyArray<SurveyEdge>
  readonly unresolved: ReadonlyArray<Unresolved>
} => {
  const known = new Set(nodes.filter((node) => nodeKind(node) === "file").map((node) => node.name))
  const edges: Array<SurveyEdge> = []
  const unresolved: Array<Unresolved> = []
  const seen = new Set<string>()
  const push = (edge: SurveyEdge) => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`
    if (!seen.has(key)) {
      seen.add(key)
      edges.push(edge)
    }
  }
  for (const rule of rules) {
    const filePattern = new RegExp(rule.files)
    for (const path of paths.filter((path) => filePattern.test(path))) {
      const text = contents.get(path) ?? ""
      const locate = lineLocator(text)
      for (const hit of captures(rule.pattern, text, locate)) {
        const reference = hit.groups.to
        if (reference === undefined) {
          continue
        }
        const fromNode =
          rule.fromKind === "file" ? undefined : enclosing(nodes, path, rule.fromKind, hit.line)
        const from = fromNode === undefined ? unitName(path) : nodeId(fromNode)
        const evidence = GraphEvidence.make({
          file: path,
          line: hit.line,
          snippet: lineText(text, hit.line).trim()
        })
        const target = resolveTarget(nodes, known, path, rule.toKind, reference)
        const targets: Array<string> = []
        if (target.found && hit.groups.thru !== undefined && rule.toKind !== "file") {
          const end = resolveTarget(nodes, known, path, rule.toKind, hit.groups.thru)
          const startLine = nodeLineStart(nodes.find((node) => nodeId(node) === target.id)!)
          const endLine = end.found
            ? nodeLineStart(nodes.find((node) => nodeId(node) === end.id)!)
            : startLine
          targets.push(
            ...nodes
              .filter((node) => node.path === path && nodeKind(node) === rule.toKind)
              .filter((node) => nodeLineStart(node) >= startLine && nodeLineStart(node) <= endLine)
              .map(nodeId)
          )
        } else if (target.found || rule.toKind === "file") {
          targets.push(target.id)
        }
        if (!target.found) {
          unresolved.push(
            Unresolved.make({
              reason: "edge-target",
              rule: rule.kind,
              node: from,
              reference,
              file: path,
              line: hit.line
            })
          )
        }
        for (const to of targets) {
          push(
            SurveyEdge.make({
              from,
              to,
              kind: rule.kind,
              origin: "scanner",
              confidence: "exact",
              rule: rule.kind,
              mechanism: "capture",
              evidence
            })
          )
        }
      }
    }
  }
  return { edges, unresolved }
}

/** Nodes and captured edges only; joins and the unresolved summary come from `applyFillsAndJoins`. */
export const scanGraph = (
  paths: ReadonlyArray<string>,
  contents: ReadonlyMap<string, string>,
  options: CodeGraphOptions
): SurveyGraph => {
  const nodes = scanNodes(paths, contents, options.coverage, options.rules.nodes)
  const { edges, unresolved } = scanEdges(paths, contents, nodes, options.rules.edges)
  return SurveyGraph.make({ nodes, edges, unresolved, fills: [] })
}

export const buildCodeGraph = Effect.fn("@llm4ts/flow/Survey.buildCodeGraph")(function* (
  workspace: WorkspaceShape,
  options: CodeGraphOptions
): Effect.fn.Return<CodeGraphBuild, WorkspaceError> {
  const paths = [
    ...(yield* workspace.discover("**/*", {
      matching: new RegExp(options.sources),
      ...(options.exclude === undefined ? {} : { excluding: new RegExp(options.exclude) })
    }))
  ].sort()
  const contents = new Map<string, string>()
  const files: Record<string, string> = {}
  for (const path of paths) {
    const text = yield* workspace.read(path)
    contents.set(path, text)
    files[path] = sha256(text)
  }
  const scanned = scanGraph(paths, contents, options)
  return { graph: applyFillsAndJoins(scanned, [], options.rules, paths), files }
})
```

Until Task 4 lands, define `applyFillsAndJoins` as `(graph, _fills, _rules, _paths) => graph` with a `// Task 4` comment and export it; Task 4 replaces the body. The per-file edge dedupe note: the old `matches()` used `g`; `captures()` uses `gm`, so `^`-anchored Survey rules now match every line, which the survey smoke test tolerates (it filters by `calls`).

Replace the body of `surveyGraph` with:

```ts
const build =
  yield *
  buildCodeGraph(workspace, {
    sources,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    coverage: units,
    rules: { ...emptyGraphRules, edges: edgeRules.map(edgeRuleOfSurvey) }
  })
return build.graph
```

and delete the now-unused `matches` helper (`captures` replaces it). Keep `unitName`, `resolveUnit`, `mergeSurveyEdges`, the renderers and the prompts.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts packages/flow/test/ReviewSurvey.test.ts flows/test/modernize-survey.smoke.test.ts`
Expected: PASS. The first scanner test's `files` count is 10 (every fixture file matches `sources`).

- [ ] **Step 6: Commit**

```bash
git add packages/flow/src/Survey.ts packages/flow/test/support/legacyMini.ts packages/flow/test/CodeGraph.test.ts
git commit -m "flow: scanner pass builds sub-file nodes and captured edges from pack rules"
```

---

### Task 4: Joins, app scope, unresolved summary, `applyFillsAndJoins`

**Files:**

- Modify: `packages/flow/src/Survey.ts`, `packages/flow/src/Domains.ts`
- Test: `packages/flow/test/CodeGraph.test.ts` (extend), `packages/flow/test/Domains.test.ts` (one case)

**Interfaces:**

- Produces: `applyFillsAndJoins(graph, fills, rules, paths?): SurveyGraph` (pure; drops every edge with `mechanism` `join:*`, re-derives them from current attrs plus fills, recomputes `unresolved`), `appRoots(paths): ReadonlyArray<string>`, `appOf(path, roots): string`.
- `clusterPrograms` in `Domains.ts` starts with `const projected = projectToFiles(graph)` and reads `projected.edges`.

- [ ] **Step 1: Write the failing tests**

Append to `CodeGraph.test.ts`:

```ts
describe("joins", () => {
  it.effect(
    "joins ajax, form and mapping nodes in servlet-spec order within the app, and wires mappings to declarations",
    () =>
      Effect.gen(function* () {
        const { graph } = yield* built
        const joins = graph.edges
          .filter((edge) => edge.mechanism?.startsWith("join:"))
          .map((edge) => `${edge.kind}:${edge.from}->${edge.to}[${edge.join ?? "-"}]`)
          .sort()
        assert.deepStrictEqual(joins, [
          "jsp-ajax-target:ajax-call:web/js/invoice.js#${ctx}/salvaFattura?id=->servlet-mapping:web/WEB-INF/web.xml#invoice[exact]",
          "jsp-ajax-target:ajax-call:web/js/invoice.js#/api/report/monthly->servlet-mapping:web/WEB-INF/web.xml#report[prefix]",
          "jsp-form-action:form:web/fattura.jsp#salvaFattura.do->servlet-mapping:web/WEB-INF/web.xml#invoice~2[extension]",
          "servlet-wiring:servlet-mapping:web/WEB-INF/web.xml#invoice->servlet-decl:web/WEB-INF/web.xml#invoice[exact]",
          "servlet-wiring:servlet-mapping:web/WEB-INF/web.xml#invoice~2->servlet-decl:web/WEB-INF/web.xml#invoice[exact]",
          "servlet-wiring:servlet-mapping:web/WEB-INF/web.xml#report->servlet-decl:web/WEB-INF/web.xml#report[exact]"
        ])
        const wiring = graph.edges.find((edge) => edge.kind === "servlet-wiring")!
        assert.strictEqual(wiring.rule, "servlet-wiring")
        assert.strictEqual(wiring.origin, "scanner")
      })
  )

  it.effect("lists what the scanner could not resolve, by reason", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const summary = graph.unresolved
        .map((item) => `${item.reason}:${item.rule}:${item.node}`)
        .sort()
      assert.deepStrictEqual(summary, [
        "edge-target:calls:cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
        "edge-target:performs:cobol-paragraph:cobol/ACCTXFR.cbl#0200-VALIDATE",
        "isolated:file:EsbInvoiceService",
        "isolated:file:OrphanServlet",
        "join-to:servlet-wiring:servlet-decl:web/WEB-INF/web.xml#orphan",
        "missing-attr:jsp-ajax-target:ajax-dynamic:web/js/invoice.js#base + '/dynamic'"
      ])
    })
  )

  it.effect("projects through descriptors so the file graph has page → servlet edges", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const projected = projectToFiles(graph)
      assert.deepStrictEqual(
        projected.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort(),
        [
          "ACCTXFR->AUDITLOG:calls",
          "ACCTXFR->FEECALC:calls",
          "fattura->InvoiceServlet:jsp-form-action",
          "fattura->header:jsp-include",
          "invoice->InvoiceServlet:jsp-ajax-target",
          "invoice->ReportServlet:jsp-ajax-target"
        ]
      )
      assert.deepStrictEqual(closureFor(graph, "fattura", 10).sort(), [
        "src/com/legacy/InvoiceServlet.java",
        "web/header.jsp"
      ])
    })
  )

  it.effect("re-derives joins after a fill and scopes url joins per app", () =>
    Effect.gen(function* () {
      const { graph, pack, build } = yield* built
      const filled = applyFillsAndJoins(
        graph,
        [
          Fill.make({
            node: "ajax-dynamic:web/js/invoice.js#base + '/dynamic'",
            key: "url",
            value: "/api/dynamic",
            evidence: { file: "web/js/invoice.js", line: 6, snippet: "$.post(base + '/dynamic');" }
          })
        ],
        pack.graph,
        Object.keys(build.files)
      )
      const edge = filled.edges.find(
        (e) => e.from === "ajax-dynamic:web/js/invoice.js#base + '/dynamic'"
      )!
      assert.strictEqual(edge.to, "servlet-mapping:web/WEB-INF/web.xml#report")
      assert.strictEqual(edge.origin, "llm")
      assert.strictEqual(edge.confidence, "inferred")
      assert.isFalse(filled.unresolved.some((item) => item.reason === "missing-attr"))
      assert.deepStrictEqual(
        appRoots(["web/WEB-INF/web.xml", "web/js/a.js", "other/WEB-INF/web.xml", "lib/x.java"]),
        ["other", "web"]
      )
      assert.strictEqual(appOf("web/js/a.js", ["other", "web"]), "web")
      assert.strictEqual(appOf("lib/x.java", ["other", "web"]), "")
    })
  )

  it.effect(
    "a second url-pattern in one mapping is not captured and leaves the ajax side unresolved, never mis-joined",
    () =>
      Effect.gen(function* () {
        const workspace = yield* makeMemoryWorkspace()
        yield* writeLegacyMini(workspace)
        yield* workspace.write(
          "web/WEB-INF/web.xml",
          [
            "<web-app>",
            "  <servlet><servlet-name>r</servlet-name><servlet-class>com.legacy.ReportServlet</servlet-class></servlet>",
            "  <servlet-mapping>",
            "    <servlet-name>r</servlet-name>",
            "    <url-pattern>/first</url-pattern>",
            "    <url-pattern>/api/*</url-pattern>",
            "  </servlet-mapping>",
            "</web-app>",
            ""
          ].join("\n")
        )
        const pack = yield* loadLegacyMiniPack(workspace)
        const { graph } = yield* buildCodeGraph(workspace, {
          sources: pack.sources ?? ".*",
          coverage: pack.coverage,
          rules: pack.graph
        })
        assert.isUndefined(
          graph.edges.find(
            (edge) =>
              edge.from === "ajax-call:web/js/invoice.js#/api/report/monthly" &&
              edge.kind === "jsp-ajax-target"
          )
        )
        assert.isTrue(
          graph.unresolved.some(
            (item) =>
              item.reason === "join-from" &&
              item.node === "ajax-call:web/js/invoice.js#/api/report/monthly"
          )
        )
      })
  )
})
```

Add `Fill`, `applyFillsAndJoins`, `appRoots`, `appOf` to the imports from `@llm4ts/flow/Survey`.

Add to `packages/flow/test/Domains.test.ts`, inside the existing `clusterPrograms` describe:

```ts
it("clusters through descriptor nodes using the file projection", () => {
  const mapping = SurveyNode.make({
    path: "web/WEB-INF/web.xml",
    name: "m",
    lines: 1,
    units: 0,
    id: "servlet-mapping:web/WEB-INF/web.xml#m",
    kind: "servlet-mapping",
    attrs: { url: "/x" },
    descriptor: true
  })
  const decl = SurveyNode.make({
    path: "web/WEB-INF/web.xml",
    name: "m",
    lines: 1,
    units: 0,
    id: "servlet-decl:web/WEB-INF/web.xml#m",
    kind: "servlet-decl",
    attrs: { class: "X" },
    descriptor: true,
    anchor: "class"
  })
  const ajax = SurveyNode.make({
    path: "src/a.jsp",
    name: "/x",
    lines: 1,
    units: 0,
    id: "ajax-call:src/a.jsp#/x",
    kind: "ajax-call",
    attrs: { url: "/x" }
  })
  const graph = SurveyGraph.make({
    nodes: [
      node("a"),
      node("X", "src/X.java"),
      node("web", "web/WEB-INF/web.xml"),
      mapping,
      decl,
      ajax
    ],
    edges: [
      edge("ajax-call:src/a.jsp#/x", "servlet-mapping:web/WEB-INF/web.xml#m", "jsp-ajax-target"),
      edge(
        "servlet-mapping:web/WEB-INF/web.xml#m",
        "servlet-decl:web/WEB-INF/web.xml#m",
        "servlet-wiring"
      )
    ]
  })
  const clusters = clusterPrograms(graph, ["a", "X"], { cluster: ["jsp-ajax-target"], context: [] })
  assert.deepStrictEqual(
    clusters.map((cluster) => [...cluster.programs].sort()),
    [["X", "a"]]
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts packages/flow/test/Domains.test.ts`
Expected: FAIL — no join edges, `appRoots` not exported, Domains cluster is two singletons.

- [ ] **Step 3: Implement joins and the unresolved summary**

In `Survey.ts`, import `matchUrl, normalizeUrl, type JoinRule` from `./GraphRules.ts` and replace the Task 3 stub:

```ts
/** Directories `D` with some scanned path under `D/WEB-INF/`, sorted; the per-app scope of url joins. */
export const appRoots = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  [
    ...new Set(
      paths.flatMap((path) => {
        const index = path.indexOf("/WEB-INF/")
        return index < 0 ? [] : [path.slice(0, index)]
      })
    )
  ].sort()

/** The longest app root that prefixes `path`, or "" for the estate scope. */
export const appOf = (path: string, roots: ReadonlyArray<string>): string =>
  [...roots]
    .filter((root) => path === root || path.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0] ?? ""

const withFills = (graph: SurveyGraph, fills: ReadonlyArray<Fill>): ReadonlyArray<SurveyNode> =>
  graph.nodes.map((node) => {
    const own = fills.filter((fill) => fill.node === nodeId(node))
    return own.length === 0
      ? node
      : new SurveyNode({
          ...node,
          attrs: {
            ...nodeAttrs(node),
            ...Object.fromEntries(own.map((fill) => [fill.key, fill.value]))
          }
        })
  })

const joinEdges = (
  nodes: ReadonlyArray<SurveyNode>,
  fills: ReadonlyArray<Fill>,
  rules: ReadonlyArray<JoinRule>,
  roots: ReadonlyArray<string>
): {
  readonly edges: ReadonlyArray<SurveyEdge>
  readonly unresolved: ReadonlyArray<Unresolved>
} => {
  const filled = new Set(fills.map((fill) => `${fill.node}\u0000${fill.key}`))
  const edges: Array<SurveyEdge> = []
  const unresolved: Array<Unresolved> = []
  const seen = new Set<string>()
  for (const rule of rules) {
    const sources = nodes.filter((node) => nodeKind(node) === rule.fromKind)
    const targets = nodes.filter((node) => nodeKind(node) === rule.toKind)
    const reached = new Set<string>()
    for (const source of sources) {
      const raw = nodeAttrs(source)[rule.fromAttr]
      if (raw === undefined) {
        unresolved.push(
          Unresolved.make({
            reason: "missing-attr",
            rule: rule.kind,
            node: nodeId(source),
            file: source.path,
            line: nodeLineStart(source)
          })
        )
        continue
      }
      const request = rule.match === "url" ? normalizeUrl(raw) : raw.trim()
      const inScope = targets.filter((target) =>
        rule.scope === "file"
          ? target.path === source.path
          : rule.scope === "app"
            ? appOf(target.path, roots) === appOf(source.path, roots)
            : true
      )
      const matched = inScope.flatMap((target) => {
        const value = nodeAttrs(target)[rule.toAttr]
        if (value === undefined) {
          return []
        }
        const how =
          rule.match === "url"
            ? matchUrl(request, value)
            : value.trim() === request
              ? "exact"
              : undefined
        return how === undefined ? [] : [{ target, how }]
      })
      // Servlet-spec order: exact beats the longest prefix beats an extension.
      const rank = { exact: 0, prefix: 1, extension: 2 } as const
      const best = matched.sort(
        (a, b) =>
          rank[a.how] - rank[b.how] ||
          (nodeAttrs(b.target)[rule.toAttr]?.length ?? 0) -
            (nodeAttrs(a.target)[rule.toAttr]?.length ?? 0)
      )[0]
      if (best === undefined) {
        unresolved.push(
          Unresolved.make({
            reason: "join-from",
            rule: rule.kind,
            node: nodeId(source),
            reference: raw,
            file: source.path,
            line: nodeLineStart(source)
          })
        )
        continue
      }
      const inferred =
        filled.has(`${nodeId(source)}\u0000${rule.fromAttr}`) ||
        filled.has(`${nodeId(best.target)}\u0000${rule.toAttr}`)
      const key = `${nodeId(source)}\u0000${nodeId(best.target)}\u0000${rule.kind}`
      if (!seen.has(key)) {
        seen.add(key)
        reached.add(nodeId(best.target))
        edges.push(
          SurveyEdge.make({
            from: nodeId(source),
            to: nodeId(best.target),
            kind: rule.kind,
            origin: inferred ? "llm" : "scanner",
            confidence: inferred ? "inferred" : "exact",
            rule: rule.kind,
            mechanism: rule.match === "url" ? "join:url" : "join:exact",
            join: best.how,
            evidence: GraphEvidence.make({
              file: source.path,
              line: nodeLineStart(source),
              snippet: raw
            })
          })
        )
      }
    }
    for (const target of targets) {
      if (
        !reached.has(nodeId(target)) &&
        !edges.some((edge) => edge.kind === rule.kind && edge.to === nodeId(target))
      ) {
        unresolved.push(
          Unresolved.make({
            reason: "join-to",
            rule: rule.kind,
            node: nodeId(target),
            file: target.path,
            line: nodeLineStart(target)
          })
        )
      }
    }
  }
  return { edges, unresolved }
}

/**
 * Pure re-derivation: every `join:*` edge is dropped and rebuilt from the
 * current attrs plus `fills`; `unresolved` is recomputed from scratch except
 * for `edge-target` entries, which only the scanner knows. `paths` defaults
 * to the node paths; pass the scanned list to compute app roots precisely.
 */
export const applyFillsAndJoins = (
  graph: SurveyGraph,
  fills: ReadonlyArray<Fill>,
  rules: GraphRules,
  paths: ReadonlyArray<string> = graph.nodes.map((node) => node.path)
): SurveyGraph => {
  const nodes = withFills(graph, fills)
  const kept = graph.edges.filter((edge) => !(edge.mechanism ?? "").startsWith("join:"))
  const joined = joinEdges(nodes, fills, rules.joins, appRoots(paths))
  const edges = [...kept, ...joined.edges]
  const interim = SurveyGraph.make({ nodes, edges, unresolved: [], fills })
  const projected = projectToFiles(interim)
  const isolated = projected.nodes
    .filter(
      (node) =>
        projected.incoming(node.name).length === 0 && projected.outgoing(node.name).length === 0
    )
    .map((node) =>
      Unresolved.make({
        reason: "isolated",
        rule: "file",
        node: node.name,
        file: node.path,
        line: 1
      })
    )
  return SurveyGraph.make({
    nodes,
    edges,
    unresolved: [
      ...graph.unresolved.filter((item) => item.reason === "edge-target"),
      ...joined.unresolved,
      ...isolated
    ],
    fills
  })
}
```

Note the `join-to` loop deliberately counts a target reached by any source of that kind, including the `~2` mapping; the fixture's `orphan` declaration is the only one left.

In `Domains.ts` `clusterPrograms`, add `const projected = projectToFiles(graph)` as the first line (import from `./Survey.ts`) and replace both `graph.edges` reads with `projected.edges`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts packages/flow/test/Domains.test.ts packages/flow/test/ReviewSurvey.test.ts flows/test/modernize-survey.smoke.test.ts flows/test/modernize-pack-check.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/Survey.ts packages/flow/src/Domains.ts packages/flow/test/CodeGraph.test.ts packages/flow/test/Domains.test.ts
git commit -m "flow: url and exact joins per app scope, unresolved summary, projection-aware clustering"
```

---

### Task 5: The graph cache and content-hash freshness

**Files:**

- Create: `packages/flow/src/GraphCache.ts`
- Modify: `packages/flow/package.json` (add `"./GraphCache": "./dist/GraphCache.js"`)
- Test: `packages/flow/test/GraphCache.test.ts` (create)

**Interfaces:**

- Consumes: `buildCodeGraph`, `applyFillsAndJoins`, `SurveyGraph`, `Fill` (Tasks 1–4); `graphRulesHash`, `GraphRules` (Task 2); `saveVersioned`/`loadVersioned`, `PlainFileStoreShape` (`Persistence.ts`).
- Produces:

  ```ts
  class GraphCacheMeta {
    version: Int
    pack
    rulesHash
    rev?: string
    builtAt: string
    files: Record<string, string>
  }
  class GraphCacheFile {
    meta: GraphCacheMeta
    graph: SurveyGraph
  }
  const graphCacheVersion = 2
  const graphCachePath: (repoRoot: string, pack: string) => string // `${repoRoot}/.llm4ts/graph/${pack}.json`
  const loadGraphCache: (files, path) => Effect<GraphCacheFile | undefined, FlowError>
  const saveGraphCache: (files, path, cache) => Effect<void, FlowError>
  const isFreshCache: (
    cache: GraphCacheFile,
    built: Readonly<Record<string, string>>,
    rulesHash: string
  ) => boolean
  const carryContributions: (
    previous: GraphCacheFile,
    next: CodeGraphBuild,
    rules: GraphRules
  ) => SurveyGraph
  interface GraphPackShape {
    name: string
    sources: string | undefined
    exclude: string | undefined
    coverage: ReadonlyArray<CoverageRule>
    graph: GraphRules
  }
  const freshGraph: (
    files,
    path,
    pack: GraphPackShape,
    workspace,
    options?: { rev?: string; builtAt?: () => string }
  ) => Effect<
    { graph: SurveyGraph; reused: boolean; cache: GraphCacheFile },
    FlowError | WorkspaceError
  >
  const updateGraphCache: (
    files,
    path,
    cache: GraphCacheFile,
    graph: SurveyGraph
  ) => Effect<void, FlowError> // after an LLM merge: same meta, new graph
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/flow/test/GraphCache.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  freshGraph,
  graphCachePath,
  loadGraphCache,
  updateGraphCache
} from "@llm4ts/flow/GraphCache"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { Fill, SurveyEdge, SurveyGraph, applyFillsAndJoins } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const setup = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const memory = yield* makeMemoryPlainFileStore()
  const path = graphCachePath("/estate", pack.name)
  return { workspace, pack, files: memory.store, path }
})

const llmEdge = SurveyEdge.make({
  from: "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
  to: "FEECALC",
  kind: "dynamic-call",
  origin: "llm",
  confidence: "inferred",
  mechanism: "llm",
  evidence: { file: "cobol/ACCTXFR.cbl", line: 13, snippet: "CALL 'AUDITLOG' USING WS-RECORD." }
})
const llmFill = Fill.make({
  node: "ajax-dynamic:web/js/invoice.js#base + '/dynamic'",
  key: "url",
  value: "/api/dynamic",
  evidence: { file: "web/js/invoice.js", line: 6, snippet: "$.post(base + '/dynamic');" }
})

describe("graph cache", () => {
  it.effect("builds once, reuses while hashes and rules match, rebuilds on a changed file", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      assert.strictEqual(graphCachePath("/estate", "p"), "/estate/.llm4ts/graph/p.json")
      const first = yield* freshGraph(files, path, pack, workspace, {
        rev: "abc",
        builtAt: () => "t0"
      })
      assert.isFalse(first.reused)
      assert.strictEqual(first.cache.meta.rev, "abc")
      const second = yield* freshGraph(files, path, pack, workspace)
      assert.isTrue(second.reused)
      yield* workspace.write("web/header.jsp", "<div>changed</div>\n")
      const third = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(third.reused)
      assert.strictEqual(
        (yield* loadGraphCache(files, path))?.meta.files["web/header.jsp"],
        third.cache.meta.files["web/header.jsp"]
      )
    })
  )

  it.effect("carries LLM edges and fills whose evidence file is unchanged and drops the rest", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      const first = yield* freshGraph(files, path, pack, workspace)
      const merged = applyFillsAndJoins(
        SurveyGraph.make({ ...first.graph, edges: [...first.graph.edges, llmEdge] }),
        [llmFill],
        pack.graph
      )
      yield* updateGraphCache(files, path, first.cache, merged)
      // Unrelated edit: both contributions survive and the fill's join is re-derived.
      yield* workspace.write("web/header.jsp", "<div>changed</div>\n")
      const after = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(after.reused)
      assert.isTrue(
        after.graph.edges.some((edge) => edge.kind === "dynamic-call" && edge.origin === "llm")
      )
      assert.strictEqual(after.graph.fills.length, 1)
      assert.isTrue(
        after.graph.edges.some(
          (edge) =>
            edge.from === llmFill.node && edge.to === "servlet-mapping:web/WEB-INF/web.xml#report"
        )
      )
      // Edit the evidence file of the edge: only the edge drops.
      yield* workspace.write("cobol/ACCTXFR.cbl", "       0100-MAIN.\n")
      const again = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(again.graph.edges.some((edge) => edge.kind === "dynamic-call"))
      assert.strictEqual(again.graph.fills.length, 1)
    })
  )

  it.effect("a changed rule set invalidates the cache even when no file changed", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      yield* freshGraph(files, path, pack, workspace)
      const narrower = { ...pack, graph: { ...pack.graph, joins: pack.graph.joins.slice(1) } }
      const rebuilt = yield* freshGraph(files, path, narrower, workspace)
      assert.isFalse(rebuilt.reused)
    })
  )

  it.effect("a cache with another schema version is rebuilt, not an error", () =>
    Effect.gen(function* () {
      const { workspace, pack, files, path } = yield* setup
      yield* files.writeAtomic(path, JSON.stringify({ schemaVersion: 1, value: {} }))
      const result = yield* freshGraph(files, path, pack, workspace)
      assert.isFalse(result.reused)
      assert.isAbove(result.graph.nodes.length, 0)
    })
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/GraphCache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `GraphCache.ts`**

```ts
// packages/flow/src/GraphCache.ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowError } from "./FlowError.ts"
import { graphRulesHash, type GraphRules } from "./GraphRules.ts"
import { loadVersioned, saveVersioned, type PlainFileStoreShape } from "./Persistence.ts"
import type { CoverageRule } from "./SpecChecks.ts"
import {
  SurveyGraph,
  applyFillsAndJoins,
  buildCodeGraph,
  edgeOrigin,
  nodeId,
  type CodeGraphBuild
} from "./Survey.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

export class GraphCacheMeta extends Schema.Class<GraphCacheMeta>("GraphCacheMeta")({
  version: Schema.Int,
  pack: Schema.String,
  rulesHash: Schema.String,
  rev: Schema.optionalKey(Schema.String),
  builtAt: Schema.String,
  files: Schema.Record(Schema.String, Schema.String)
}) {}

export class GraphCacheFile extends Schema.Class<GraphCacheFile>("GraphCacheFile")({
  meta: GraphCacheMeta,
  graph: SurveyGraph
}) {}

export const graphCacheVersion = 2

export const graphCachePath = (repoRoot: string, pack: string): string =>
  `${repoRoot.replace(/\/+$/, "")}/.llm4ts/graph/${pack}.json`

export const loadGraphCache = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<GraphCacheFile | undefined, FlowError> =>
  loadVersioned(files, path, graphCacheVersion, GraphCacheFile).pipe(
    // A cache from another version or a corrupt one is rebuilt, never fatal.
    Effect.catchTag("UnsupportedSchemaVersion", () => Effect.succeed(undefined)),
    Effect.catchTag("PlanParseError", () => Effect.succeed(undefined))
  )

export const saveGraphCache = (
  files: PlainFileStoreShape,
  path: string,
  cache: GraphCacheFile
): Effect.Effect<void, FlowError> =>
  saveVersioned(files, path, graphCacheVersion, GraphCacheFile, cache)

export const isFreshCache = (
  cache: GraphCacheFile,
  built: Readonly<Record<string, string>>,
  rulesHash: string
): boolean => {
  const cached = cache.meta.files
  const paths = Object.keys(built)
  return (
    cache.meta.rulesHash === rulesHash &&
    paths.length === Object.keys(cached).length &&
    paths.every((path) => cached[path] === built[path])
  )
}

/**
 * LLM and external contributions survive a rebuild while the file their
 * evidence cites is byte-identical and both endpoints still exist; joins are
 * then re-derived over the carried fills.
 */
export const carryContributions = (
  previous: GraphCacheFile,
  next: CodeGraphBuild,
  rules: GraphRules
): SurveyGraph => {
  const unchanged = (file: string): boolean =>
    previous.meta.files[file] !== undefined && previous.meta.files[file] === next.files[file]
  const ids = new Set(next.graph.nodes.map(nodeId))
  const carriedEdges = previous.graph.edges.filter(
    (edge) =>
      edgeOrigin(edge) !== "scanner" &&
      !(edge.mechanism ?? "").startsWith("join:") &&
      edge.evidence !== undefined &&
      unchanged(edge.evidence.file) &&
      ids.has(edge.from) &&
      ids.has(edge.to)
  )
  const carriedFills = previous.graph.fills.filter(
    (fill) => unchanged(fill.evidence.file) && ids.has(fill.node)
  )
  const seeded = SurveyGraph.make({
    nodes: next.graph.nodes,
    edges: [...next.graph.edges, ...carriedEdges],
    unresolved: next.graph.unresolved,
    fills: []
  })
  return applyFillsAndJoins(seeded, carriedFills, rules, Object.keys(next.files))
}

export interface GraphPackShape {
  readonly name: string
  readonly sources: string | undefined
  readonly exclude: string | undefined
  readonly coverage: ReadonlyArray<CoverageRule>
  readonly graph: GraphRules
}

export interface FreshGraphOptions {
  readonly rev?: string
  readonly builtAt?: () => string
}

/**
 * The graph for this pack and estate: the cache when every scanned file's hash
 * and the rule hash match, else a scanner rebuild with contributions carried
 * over, saved before it is returned. Scanning is the cost either way; the LLM
 * pass is what the cache protects.
 */
export const freshGraph = Effect.fn("@llm4ts/flow/GraphCache.freshGraph")(function* (
  files: PlainFileStoreShape,
  path: string,
  pack: GraphPackShape,
  workspace: WorkspaceShape,
  options: FreshGraphOptions = {}
): Effect.fn.Return<
  { readonly graph: SurveyGraph; readonly reused: boolean; readonly cache: GraphCacheFile },
  FlowError | WorkspaceError
> {
  const built = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    ...(pack.exclude === undefined ? {} : { exclude: pack.exclude }),
    coverage: pack.coverage,
    rules: pack.graph
  })
  const rulesHash = graphRulesHash(pack.graph)
  const previous = yield* loadGraphCache(files, path)
  if (previous !== undefined && isFreshCache(previous, built.files, rulesHash)) {
    return { graph: previous.graph, reused: true, cache: previous }
  }
  const graph =
    previous === undefined ? built.graph : carryContributions(previous, built, pack.graph)
  const cache = GraphCacheFile.make({
    meta: GraphCacheMeta.make({
      version: graphCacheVersion,
      pack: pack.name,
      rulesHash,
      ...(options.rev === undefined ? {} : { rev: options.rev }),
      builtAt: (options.builtAt ?? (() => new Date().toISOString()))(),
      files: built.files
    }),
    graph
  })
  yield* saveGraphCache(files, path, cache)
  return { graph, reused: false, cache }
})

/** After an LLM merge: same meta, the merged graph. */
export const updateGraphCache = (
  files: PlainFileStoreShape,
  path: string,
  cache: GraphCacheFile,
  graph: SurveyGraph
): Effect.Effect<void, FlowError> =>
  saveGraphCache(files, path, GraphCacheFile.make({ meta: cache.meta, graph }))
```

`Pack` satisfies `GraphPackShape` structurally (`name`, `sources`, `exclude`, `coverage`, `graph`), so flows pass `pack` directly.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/flow/test/GraphCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/GraphCache.ts packages/flow/package.json packages/flow/test/GraphCache.test.ts
git commit -m "flow: content-hashed graph cache that carries LLM contributions across rebuilds"
```

---

### Task 6: The LLM worklist — items, prompt, verification, merge

**Files:**

- Create: `packages/flow/src/GraphWorklist.ts`
- Modify: `packages/flow/package.json` (add `"./GraphWorklist": "./dist/GraphWorklist.js"`)
- Test: `packages/flow/test/GraphWorklist.test.ts` (create)

**Interfaces:**

- Consumes: `SurveyGraph`, `Unresolved`, `Fill`, `SurveyEdge`, `GraphEvidence`, `applyFillsAndJoins`, helpers; `GraphRules`; `JsonSchema` from `@llm4ts/core/Models`.
- Produces:

  ```ts
  interface WorklistItem {
    unresolved: Unresolved
    node: SurveyNode
    context: string
    candidates: ReadonlyArray<{ id: string; label: string; attrs: Record<string, string> }>
  }
  const worklistOf: (
    graph,
    contents: (path: string) => string | undefined,
    max: number
  ) => ReadonlyArray<WorklistItem>
  const worklistBatches: <A>(
    items: ReadonlyArray<A>,
    size: number
  ) => ReadonlyArray<ReadonlyArray<A>>
  const worklistPrompt: (batch: ReadonlyArray<WorklistItem>, guidance: string | undefined) => string
  class WorklistEdge {
    from
    to
    kind
    evidence: GraphEvidence
  }
  class WorklistAttr {
    node
    key
    value
    evidence: GraphEvidence
  }
  class WorklistAnswer {
    edges: WorklistEdge[]
    attrs: WorklistAttr[]
    notes: string[]
  }
  const worklistAnswerJsonSchema: JsonSchema
  interface VerifiedWorklist {
    edges: ReadonlyArray<SurveyEdge>
    fills: ReadonlyArray<Fill>
    dropped: ReadonlyArray<{ what: string; reason: string }>
  }
  const verifyWorklistAnswer: (answer: WorklistAnswer, graph, contents) => VerifiedWorklist
  const mergeWorklist: (graph, verified: VerifiedWorklist, rules: GraphRules) => SurveyGraph
  const renderWorklistReport: (
    items: ReadonlyArray<WorklistItem>,
    verified: VerifiedWorklist,
    notes: ReadonlyArray<string>
  ) => string
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/flow/test/GraphWorklist.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  WorklistAnswer,
  mergeWorklist,
  renderWorklistReport,
  verifyWorklistAnswer,
  worklistBatches,
  worklistOf,
  worklistPrompt
} from "@llm4ts/flow/GraphWorklist"
import { buildCodeGraph } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { legacyMiniFiles, loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const contents = (path: string): string | undefined => legacyMiniFiles[path]

const built = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const { graph } = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    coverage: pack.coverage,
    rules: pack.graph
  })
  return { graph, pack }
})

describe("graph worklist", () => {
  it.effect(
    "lists unresolved items highest-degree first with context and lexical candidates, capped",
    () =>
      Effect.gen(function* () {
        const { graph } = yield* built
        const items = worklistOf(graph, contents, 10)
        assert.strictEqual(items.length, 6)
        // 0300-POST has two edges touching it; isolated files have none.
        assert.strictEqual(items[0]?.unresolved.node, "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST")
        assert.include(items[0]?.context, "CALL 'AUDITLOG'")
        const dynamic = items.find((item) => item.unresolved.reason === "missing-attr")!
        assert.include(dynamic.context, "$.post(base + '/dynamic')")
        assert.isTrue(
          dynamic.candidates.some((candidate) => candidate.id.startsWith("servlet-mapping:"))
        )
        assert.strictEqual(worklistOf(graph, contents, 2).length, 2)
        assert.deepStrictEqual(worklistBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
        const prompt = worklistPrompt(items.slice(0, 2), "Stack guidance here.")
        assert.include(prompt, "Stack guidance here.")
        assert.include(prompt, "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST")
        assert.include(prompt, '"attrs"')
        assert.include(prompt, "never invent a node")
      })
  )

  it.effect(
    "verifies evidence within two lines, drops wrong lines and unknown endpoints, merges the rest and re-joins",
    () =>
      Effect.gen(function* () {
        const { graph, pack } = yield* built
        const answer = WorklistAnswer.make({
          edges: [
            // accepted: snippet present on line 13 (stated 12, within two)
            {
              from: "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
              to: "FEECALC",
              kind: "audit-call",
              evidence: {
                file: "cobol/ACCTXFR.cbl",
                line: 12,
                snippet: "CALL 'AUDITLOG' USING WS-RECORD."
              }
            },
            // dropped: snippet is three lines away
            {
              from: "cobol-paragraph:cobol/ACCTXFR.cbl#0100-MAIN",
              to: "FEECALC",
              kind: "far",
              evidence: {
                file: "cobol/ACCTXFR.cbl",
                line: 10,
                snippet: "CALL 'FEECALC' USING WS-AMOUNT."
              }
            },
            // dropped: endpoint is a literal no node owns
            {
              from: "cobol-paragraph:cobol/ACCTXFR.cbl#0300-POST",
              to: "AUDITLOG",
              kind: "calls",
              evidence: {
                file: "cobol/ACCTXFR.cbl",
                line: 13,
                snippet: "CALL 'AUDITLOG' USING WS-RECORD."
              }
            },
            // dropped: duplicate of a scanner edge
            {
              from: "fattura",
              to: "header",
              kind: "jsp-include",
              evidence: {
                file: "web/fattura.jsp",
                line: 2,
                snippet: '<jsp:include page="/web/header.jsp"/>'
              }
            }
          ],
          attrs: [
            {
              node: "ajax-dynamic:web/js/invoice.js#base + '/dynamic'",
              key: "url",
              value: "/api/dynamic",
              evidence: {
                file: "web/js/invoice.js",
                line: 6,
                snippet: "$.post(base + '/dynamic');"
              }
            },
            // dropped: unknown node
            {
              node: "ajax-dynamic:web/js/invoice.js#ghost",
              key: "url",
              value: "/x",
              evidence: {
                file: "web/js/invoice.js",
                line: 6,
                snippet: "$.post(base + '/dynamic');"
              }
            }
          ],
          notes: ["AUDITLOG is a platform service"]
        })
        const verified = verifyWorklistAnswer(answer, graph, contents)
        assert.strictEqual(verified.edges.length, 1)
        assert.strictEqual(verified.edges[0]?.origin, "llm")
        assert.strictEqual(verified.edges[0]?.confidence, "inferred")
        assert.strictEqual(verified.edges[0]?.mechanism, "llm")
        assert.strictEqual(verified.edges[0]?.evidence?.line, 13)
        assert.strictEqual(verified.fills.length, 1)
        assert.deepStrictEqual(verified.dropped.map((drop) => drop.reason).sort(), [
          "duplicate of an existing edge",
          "snippet not found within two lines of line 10",
          "unknown endpoint: AUDITLOG",
          "unknown node: ajax-dynamic:web/js/invoice.js#ghost"
        ])
        const merged = mergeWorklist(graph, verified, pack.graph)
        assert.isTrue(merged.edges.some((edge) => edge.kind === "audit-call"))
        assert.isTrue(
          merged.edges.some(
            (edge) =>
              edge.from === "ajax-dynamic:web/js/invoice.js#base + '/dynamic'" &&
              edge.to === "servlet-mapping:web/WEB-INF/web.xml#report" &&
              edge.origin === "llm"
          )
        )
        assert.strictEqual(merged.fills.length, 1)
        const report = renderWorklistReport(worklistOf(graph, contents, 10), verified, answer.notes)
        assert.include(report, "1 edge(s) and 1 attr fill(s) accepted")
        assert.include(report, "snippet not found")
        assert.include(report, "AUDITLOG is a platform service")
      })
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/GraphWorklist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `GraphWorklist.ts`**

````ts
// packages/flow/src/GraphWorklist.ts
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { GraphRules } from "./GraphRules.ts"
import {
  Fill,
  GraphEvidence,
  SurveyEdge,
  SurveyGraph,
  applyFillsAndJoins,
  nodeAttrs,
  nodeId,
  nodeLabel,
  nodeLineStart,
  type SurveyNode,
  type Unresolved
} from "./Survey.ts"

export interface WorklistCandidate {
  readonly id: string
  readonly label: string
  readonly attrs: Readonly<Record<string, string>>
}

export interface WorklistItem {
  readonly unresolved: Unresolved
  readonly node: SurveyNode
  /** Fifteen lines either side of the item's line, numbered. */
  readonly context: string
  readonly candidates: ReadonlyArray<WorklistCandidate>
}

const contextWindow = 15
const candidateLimit = 8

const tokens = (text: string): ReadonlyArray<string> => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
  )
]

const numbered = (text: string, line: number): string =>
  text
    .split(/\r?\n/)
    .map((content, index) => ({ number: index + 1, content }))
    .filter(({ number }) => Math.abs(number - line) <= contextWindow)
    .map(({ number, content }) => `${String(number).padStart(4, " ")}  ${content}`)
    .join("\n")

const candidatesFor = (
  graph: SurveyGraph,
  item: Unresolved,
  node: SurveyNode
): ReadonlyArray<WorklistCandidate> => {
  const needles = tokens(
    `${item.reference ?? ""} ${node.name} ${Object.values(nodeAttrs(node)).join(" ")}`
  )
  return graph.nodes
    .filter((candidate) => nodeId(candidate) !== nodeId(node))
    .map((candidate) => {
      const hay =
        `${nodeId(candidate)} ${nodeLabel(candidate)} ${Object.values(nodeAttrs(candidate)).join(" ")}`.toLowerCase()
      return { candidate, score: needles.filter((needle) => hay.includes(needle)).length }
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || nodeId(left.candidate).localeCompare(nodeId(right.candidate))
    )
    .slice(0, candidateLimit)
    .map(({ candidate }) => ({
      id: nodeId(candidate),
      label: nodeLabel(candidate),
      attrs: nodeAttrs(candidate)
    }))
}

/** Unresolved items, highest-degree node first (hubs resolve first), capped at `max`. */
export const worklistOf = (
  graph: SurveyGraph,
  contents: (path: string) => string | undefined,
  max: number
): ReadonlyArray<WorklistItem> => {
  const degree = (id: string): number => graph.incoming(id).length + graph.outgoing(id).length
  return [...graph.unresolved]
    .sort(
      (left, right) => degree(right.node) - degree(left.node) || left.node.localeCompare(right.node)
    )
    .flatMap((item) => {
      const node = graph.node(item.node)
      if (node === undefined) {
        return []
      }
      return [
        {
          unresolved: item,
          node,
          context: numbered(contents(item.file) ?? "", item.line),
          candidates: candidatesFor(graph, item, node)
        }
      ]
    })
    .slice(0, max)
}

export const worklistBatches = <A>(
  items: ReadonlyArray<A>,
  size: number
): ReadonlyArray<ReadonlyArray<A>> => {
  const step = Math.max(1, Math.floor(size))
  const batches: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < items.length; index += step) {
    batches.push(items.slice(index, index + step))
  }
  return batches
}

const describeItem = (item: WorklistItem, index: number): string =>
  [
    `### Item ${index + 1}: ${item.unresolved.reason} — rule '${item.unresolved.rule}'`,
    `Node: ${nodeId(item.node)} (line ${nodeLineStart(item.node)} of ${item.node.path})`,
    ...(item.unresolved.reference === undefined
      ? []
      : [`Reference the scanner could not resolve: ${item.unresolved.reference}`]),
    `Candidates (existing nodes with matching tokens): ${item.candidates.length === 0 ? "none" : item.candidates.map((candidate) => `${candidate.id}${Object.keys(candidate.attrs).length === 0 ? "" : ` ${JSON.stringify(candidate.attrs)}`}`).join("; ")}`,
    "Source context:",
    "```",
    item.context,
    "```"
  ].join("\n")

const defaultGuidance = [
  "Regexes miss links the source establishes indirectly: a URL assembled from a variable or",
  "configuration entry, a target held in a field, wiring declared in a descriptor, a fragment",
  "pulled in by templating."
].join("\n")

export const worklistPrompt = (
  batch: ReadonlyArray<WorklistItem>,
  guidance: string | undefined
): string =>
  [
    "You are resolving holes in the dependency graph of a legacy estate. The graph was built",
    "deterministically from pack rules; each item below is something the scanner could not",
    "resolve. You have read-only access to the estate.",
    guidance ?? defaultGuidance,
    "",
    "For each item, either resolve it or leave it. You may:",
    '- fill a missing attribute of an EXISTING node ("attrs": node id, key, value) — e.g. the URL an',
    "  ajax call actually hits once its prefix variable is known;",
    '- add an edge between two EXISTING nodes ("edges": from id, to id, a short kebab-case kind).',
    "Every entry carries evidence: the file, the 1-based line, and the exact statement on that line.",
    "No evidence, no entry. Use node ids exactly as given; never invent a node, a file or a line.",
    'External systems, platform services and third-party libraries are not nodes; put them in "notes".',
    "",
    ...batch.map(describeItem),
    "",
    'Respond only with JSON: {"edges":[{"from","to","kind","evidence":{"file","line","snippet"}}],',
    '"attrs":[{"node","key","value","evidence":{"file","line","snippet"}}],"notes":[…]}'
  ].join("\n")

export class WorklistEdge extends Schema.Class<WorklistEdge>("WorklistEdge")({
  from: Schema.String,
  to: Schema.String,
  kind: Schema.String,
  evidence: GraphEvidence
}) {}
export class WorklistAttr extends Schema.Class<WorklistAttr>("WorklistAttr")({
  node: Schema.String,
  key: Schema.String,
  value: Schema.String,
  evidence: GraphEvidence
}) {}
export class WorklistAnswer extends Schema.Class<WorklistAnswer>("WorklistAnswer")({
  edges: Schema.Array(WorklistEdge),
  attrs: Schema.Array(WorklistAttr),
  notes: Schema.Array(Schema.String)
}) {}

const evidenceJsonSchema: JsonSchema = {
  type: "object",
  properties: { file: { type: "string" }, line: { type: "integer" }, snippet: { type: "string" } },
  required: ["file", "line", "snippet"]
}

export const worklistAnswerJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          kind: { type: "string" },
          evidence: evidenceJsonSchema
        },
        required: ["from", "to", "kind", "evidence"]
      }
    },
    attrs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          node: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          evidence: evidenceJsonSchema
        },
        required: ["node", "key", "value", "evidence"]
      }
    },
    notes: { type: "array", items: { type: "string" } }
  },
  required: ["edges", "attrs", "notes"]
}

export interface VerifiedWorklist {
  readonly edges: ReadonlyArray<SurveyEdge>
  readonly fills: ReadonlyArray<Fill>
  readonly dropped: ReadonlyArray<{ readonly what: string; readonly reason: string }>
}

const tolerance = 2

/** The 1-based line within ±2 of `line` whose text contains the trimmed snippet, or undefined. */
const locateSnippet = (
  text: string | undefined,
  line: number,
  snippet: string
): number | undefined => {
  if (text === undefined) {
    return undefined
  }
  const needle = snippet.trim()
  if (needle.length === 0) {
    return undefined
  }
  const lines = text.split(/\r?\n/)
  for (const delta of [0, -1, 1, -2, 2]) {
    const candidate = line + delta
    if (candidate >= 1 && (lines[candidate - 1] ?? "").includes(needle)) {
      return candidate
    }
  }
  return undefined
}

export const verifyWorklistAnswer = (
  answer: WorklistAnswer,
  graph: SurveyGraph,
  contents: (path: string) => string | undefined
): VerifiedWorklist => {
  const ids = new Set(graph.nodes.map(nodeId))
  const existing = new Set(graph.edges.map((edge) => `${edge.from}\u0000${edge.to}`))
  const edges: Array<SurveyEdge> = []
  const fills: Array<Fill> = []
  const dropped: Array<{ what: string; reason: string }> = []
  const verified = (evidence: GraphEvidence): GraphEvidence | string => {
    const line = locateSnippet(contents(evidence.file), evidence.line, evidence.snippet)
    return line === undefined
      ? `snippet not found within two lines of line ${evidence.line}`
      : GraphEvidence.make({ file: evidence.file, line, snippet: evidence.snippet.trim() })
  }
  for (const edge of answer.edges) {
    const what = `${edge.from} -> ${edge.to} (${edge.kind})`
    const unknown = [edge.from, edge.to].find((id) => !ids.has(id))
    if (unknown !== undefined) {
      dropped.push({ what, reason: `unknown endpoint: ${unknown}` })
      continue
    }
    if (edge.from === edge.to) {
      dropped.push({ what, reason: "self loop" })
      continue
    }
    if (existing.has(`${edge.from}\u0000${edge.to}`)) {
      dropped.push({ what, reason: "duplicate of an existing edge" })
      continue
    }
    const evidence = verified(edge.evidence)
    if (typeof evidence === "string") {
      dropped.push({ what, reason: evidence })
      continue
    }
    existing.add(`${edge.from}\u0000${edge.to}`)
    edges.push(
      SurveyEdge.make({
        from: edge.from,
        to: edge.to,
        kind: edge.kind.replace(/^llm-/, ""),
        origin: "llm",
        confidence: "inferred",
        rule: "llm",
        mechanism: "llm",
        evidence
      })
    )
  }
  for (const attr of answer.attrs) {
    const what = `${attr.node}.${attr.key} = ${attr.value}`
    if (!ids.has(attr.node)) {
      dropped.push({ what, reason: `unknown node: ${attr.node}` })
      continue
    }
    const evidence = verified(attr.evidence)
    if (typeof evidence === "string") {
      dropped.push({ what, reason: evidence })
      continue
    }
    fills.push(Fill.make({ node: attr.node, key: attr.key, value: attr.value, evidence }))
  }
  return { edges, fills, dropped }
}

export const mergeWorklist = (
  graph: SurveyGraph,
  verified: VerifiedWorklist,
  rules: GraphRules
): SurveyGraph =>
  applyFillsAndJoins(
    SurveyGraph.make({
      nodes: graph.nodes,
      edges: [...graph.edges, ...verified.edges],
      unresolved: graph.unresolved,
      fills: []
    }),
    [...graph.fills, ...verified.fills],
    rules
  )

const cell = (text: string): string => text.split(/\r?\n/).join(" ").replaceAll("|", "\\|")

export const renderWorklistReport = (
  items: ReadonlyArray<WorklistItem>,
  verified: VerifiedWorklist,
  notes: ReadonlyArray<string>
): string =>
  [
    "# Graph refine (LLM worklist)",
    "",
    `${items.length} unresolved item(s) offered; ${verified.edges.length} edge(s) and ${verified.fills.length} attr fill(s) accepted; ${verified.dropped.length} dropped.`,
    "Accepted entries carry the source line that establishes them and are re-verified on every rebuild.",
    "",
    "## Accepted",
    "",
    "| What | Evidence |",
    "| ---- | -------- |",
    ...verified.edges.map(
      (edge) =>
        `| ${cell(`${edge.from} → ${edge.to} (${edge.kind})`)} | ${cell(`${edge.evidence?.file}:${edge.evidence?.line} ${edge.evidence?.snippet ?? ""}`)} |`
    ),
    ...verified.fills.map(
      (fill) =>
        `| ${cell(`${fill.node}.${fill.key} = ${fill.value}`)} | ${cell(`${fill.evidence.file}:${fill.evidence.line} ${fill.evidence.snippet}`)} |`
    ),
    "",
    "## Dropped",
    "",
    "| What | Reason |",
    "| ---- | ------ |",
    ...verified.dropped.map((drop) => `| ${cell(drop.what)} | ${cell(drop.reason)} |`),
    "",
    ...(notes.length === 0 ? [] : ["## Notes", "", ...notes.map((note) => `- ${cell(note)}`), ""])
  ].join("\n")
````

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/flow/test/GraphWorklist.test.ts`
Expected: PASS. If the first item is not `0300-POST`, check the degree tie-break: `0300-POST` has one incoming `performs`, one incoming `goes-to` and one outgoing `calls` to `AUDITLOG`.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/GraphWorklist.ts packages/flow/package.json packages/flow/test/GraphWorklist.test.ts
git commit -m "flow: bounded LLM worklist with evidence verification for the code graph"
```

---

### Task 7: Queries — search, neighbourhood, shortest path, closure view, stats, node refs, probes

**Files:**

- Create: `packages/flow/src/GraphQuery.ts`
- Modify: `packages/flow/package.json` (add `"./GraphQuery": "./dist/GraphQuery.js"`)
- Test: `packages/flow/test/GraphQuery.test.ts` (create)

**Interfaces:**

- Produces:

  ```ts
  interface GraphView {
    nodes: ReadonlyArray<SurveyNode>
    edges: ReadonlyArray<SurveyEdge>
  }
  interface SearchHit {
    node: SurveyNode
    score: number
  }
  const searchNodes: (
    graph,
    text,
    options?: { kind?: string; limit?: number }
  ) => ReadonlyArray<SearchHit>
  const neighborhood: (graph, ids: ReadonlyArray<string>, hops: number) => GraphView
  const shortestPath: (
    graph,
    from: string,
    to: string,
    maxHops?: number
  ) => ReadonlyArray<SurveyEdge> | undefined
  const pathBetween: (
    graph,
    a,
    b,
    maxHops?
  ) => { forward?: ReadonlyArray<SurveyEdge>; backward?: ReadonlyArray<SurveyEdge> }
  const viewOfPath: (graph, path: ReadonlyArray<SurveyEdge>) => GraphView
  const closureView: (graph, program: string, maxFiles: number) => GraphView // file projection
  const wholeView: (graph) => GraphView
  interface GraphStats {
    nodes: Record<string, number>
    edges: Record<string, number>
    origin: Record<string, number>
    mechanism: Record<string, number>
    confidence: Record<string, number>
    unresolved: Record<string, number>
    total: { nodes: number; edges: number; unresolved: number; fills: number }
  }
  const graphStats: (graph) => GraphStats
  const resolveNodeRef: (graph, ref: string) => SurveyNode | undefined // id | `<kind>:<name>` | name (file unit)
  type ProbeStatus = "ok" | "broken" | "unknown-from" | "unknown-to"
  interface ProbeResult {
    probe: ProbeRule
    status: ProbeStatus
    path?: ReadonlyArray<SurveyEdge>
  }
  const probeResults: (
    graph,
    probes: ReadonlyArray<ProbeRule>,
    maxHops?: number
  ) => ReadonlyArray<ProbeResult>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/flow/test/GraphQuery.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  closureView,
  graphStats,
  neighborhood,
  pathBetween,
  probeResults,
  resolveNodeRef,
  searchNodes,
  shortestPath
} from "@llm4ts/flow/GraphQuery"
import { buildCodeGraph, nodeId } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const built = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const { graph } = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    coverage: pack.coverage,
    rules: pack.graph
  })
  return { graph, pack }
})

describe("graph queries", () => {
  it.effect("searches by id, name, path and attrs, boosts file-mates, filters by kind", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const hits = searchNodes(graph, "salvaFattura")
      assert.strictEqual(nodeId(hits[0]!.node), "servlet-mapping:web/WEB-INF/web.xml#invoice")
      assert.isTrue(hits.some((hit) => nodeId(hit.node) === "form:web/fattura.jsp#salvaFattura.do"))
      // The declaration shares web.xml with two hits and is itself a weak match on nothing: co-location pulls it in last.
      assert.isTrue(
        hits.some((hit) => nodeId(hit.node) === "servlet-decl:web/WEB-INF/web.xml#invoice")
      )
      assert.deepStrictEqual(
        searchNodes(graph, "invoice", { kind: "servlet-decl" }).map((hit) => nodeId(hit.node)),
        ["servlet-decl:web/WEB-INF/web.xml#invoice"]
      )
      assert.strictEqual(searchNodes(graph, "a", { limit: 3 }).length, 3)
    })
  )

  it.effect("walks neighbourhoods and finds shortest paths in either direction", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const one = neighborhood(graph, ["servlet-mapping:web/WEB-INF/web.xml#invoice"], 1)
      assert.deepStrictEqual(one.nodes.map(nodeId).sort(), [
        "ajax-call:web/js/invoice.js#${ctx}/salvaFattura?id=",
        "servlet-decl:web/WEB-INF/web.xml#invoice",
        "servlet-mapping:web/WEB-INF/web.xml#invoice"
      ])
      const path = shortestPath(
        graph,
        "fattura",
        "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura"
      )
      assert.isUndefined(path) // raw graph: fattura → form is containment, not an edge
      const fromForm = shortestPath(
        graph,
        "form:web/fattura.jsp#salvaFattura.do",
        "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura"
      )
      assert.isUndefined(fromForm) // decl → InvoiceServlet is an anchor, not an edge, on the raw graph
      const projectedPath = shortestPath(graph, "fattura", "InvoiceServlet", 8, { projected: true })
      assert.deepStrictEqual(
        projectedPath?.map((edge) => edge.kind),
        ["jsp-form-action"]
      )
      const both = pathBetween(graph, "InvoiceServlet", "fattura", 8, { projected: true })
      assert.isUndefined(both.forward)
      assert.strictEqual(both.backward?.length, 1)
    })
  )

  it.effect("resolves node references and evaluates probes on the projected-or-raw union", () =>
    Effect.gen(function* () {
      const { graph, pack } = yield* built
      assert.strictEqual(nodeId(resolveNodeRef(graph, "fattura")!), "fattura")
      assert.strictEqual(
        nodeId(resolveNodeRef(graph, "esb-call:SalvaFattura")!),
        "esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura"
      )
      assert.strictEqual(
        nodeId(resolveNodeRef(graph, "servlet-mapping:web/WEB-INF/web.xml#invoice~2")!),
        "servlet-mapping:web/WEB-INF/web.xml#invoice~2"
      )
      assert.isUndefined(resolveNodeRef(graph, "ghost"))
      const results = probeResults(graph, pack.graph.probes)
      assert.deepStrictEqual(
        results.map((result) => `${result.probe.name}:${result.status}`),
        ["save-invoice:ok", "monthly-report:ok", "orphan:broken"]
      )
      assert.deepStrictEqual(
        results[0]?.path?.map((edge) => edge.kind),
        ["jsp-form-action", "invokes-esb"]
      )
    })
  )

  it.effect("closure view and stats", () =>
    Effect.gen(function* () {
      const { graph } = yield* built
      const view = closureView(graph, "fattura", 10)
      assert.deepStrictEqual(view.nodes.map(nodeId).sort(), ["InvoiceServlet", "fattura", "header"])
      const stats = graphStats(graph)
      assert.strictEqual(stats.nodes["cobol-paragraph"], 5)
      assert.strictEqual(stats.edges["servlet-wiring"], 3)
      assert.strictEqual(stats.mechanism["join:url"], 3)
      assert.strictEqual(stats.origin.scanner, stats.total.edges)
      assert.strictEqual(stats.unresolved["edge-target"], 2)
    })
  )
})
```

The probe path for `save-invoice` runs on the **union graph**: raw edges plus the projected edges (so `fattura → InvoiceServlet` exists) plus containment edges from each file node to its sub-file nodes (so `InvoiceServlet → esb-call` is reachable through the raw `invokes-esb` edge). Define that union once as `probeGraph(graph)` and use it for probes and for `--projected` path queries.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/GraphQuery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `GraphQuery.ts`**

```ts
// packages/flow/src/GraphQuery.ts
import type { ProbeRule } from "./GraphRules.ts"
import {
  SurveyEdge,
  SurveyGraph,
  closureFor,
  edgeConfidence,
  edgeOrigin,
  nodeAttrs,
  nodeId,
  nodeKind,
  nodeLabel,
  projectToFiles,
  type SurveyNode
} from "./Survey.ts"

export interface GraphView {
  readonly nodes: ReadonlyArray<SurveyNode>
  readonly edges: ReadonlyArray<SurveyEdge>
}

export interface SearchHit {
  readonly node: SurveyNode
  readonly score: number
}

const lower = (text: string): string => text.toLowerCase()

/** Substring search over id, name, label, path and attr values; file-mates of a strong hit get a small boost. */
export const searchNodes = (
  graph: SurveyGraph,
  text: string,
  options: { readonly kind?: string; readonly limit?: number } = {}
): ReadonlyArray<SearchHit> => {
  const needle = lower(text.trim())
  if (needle.length === 0) {
    return []
  }
  const base = graph.nodes.map((node) => {
    let score = 0
    if (lower(node.name) === needle) score += 6
    else if (lower(node.name).includes(needle)) score += 3
    if (lower(nodeLabel(node)).includes(needle)) score += 2
    if (Object.values(nodeAttrs(node)).some((value) => lower(value).includes(needle))) score += 2
    if (lower(nodeId(node)).includes(needle) || lower(node.path).includes(needle)) score += 1
    return { node, score }
  })
  const strongFiles = new Set(base.filter((hit) => hit.score >= 3).map((hit) => hit.node.path))
  return base
    .map((hit) =>
      hit.score === 0 && strongFiles.has(hit.node.path) ? { ...hit, score: 0.5 } : hit
    )
    .filter(
      (hit) => hit.score > 0 && (options.kind === undefined || nodeKind(hit.node) === options.kind)
    )
    .sort(
      (left, right) =>
        right.score - left.score || nodeId(left.node).localeCompare(nodeId(right.node))
    )
    .slice(0, options.limit ?? 20)
}

const viewOf = (graph: SurveyGraph, ids: ReadonlySet<string>): GraphView => ({
  nodes: graph.nodes.filter((node) => ids.has(nodeId(node))),
  edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to))
})

export const neighborhood = (
  graph: SurveyGraph,
  ids: ReadonlyArray<string>,
  hops: number
): GraphView => {
  const seen = new Set(ids)
  let frontier = [...ids]
  for (let hop = 0; hop < hops && frontier.length > 0; hop += 1) {
    const next = frontier
      .flatMap((id) => [
        ...graph.outgoing(id).map((edge) => edge.to),
        ...graph.incoming(id).map((edge) => edge.from)
      ])
      .filter((id) => !seen.has(id))
    next.forEach((id) => seen.add(id))
    frontier = [...new Set(next)]
  }
  return viewOf(graph, seen)
}

/** Raw edges + projected file edges + file→sub-node containment: what probes and `--projected` paths walk. */
export const probeGraph = (graph: SurveyGraph): SurveyGraph => {
  const projected = projectToFiles(graph)
  const containment = graph.nodes
    .filter((node) => nodeKind(node) !== "file")
    .map((node) =>
      SurveyEdge.make({
        from: node.name === nodeId(node) ? nodeId(node) : unitOfPath(node.path),
        to: nodeId(node),
        kind: "contains",
        mechanism: "contraction"
      })
    )
  return SurveyGraph.make({
    nodes: graph.nodes,
    edges: [...graph.edges, ...projected.edges, ...containment],
    unresolved: graph.unresolved,
    fills: graph.fills
  })
}

const unitOfPath = (path: string): string => {
  const base = path.split("/").at(-1) ?? path
  const dot = base.lastIndexOf(".")
  return dot < 0 ? base : base.slice(0, dot)
}

/** Bidirectional BFS over directed edges; the path as edges from `from` to `to`. */
export const shortestPath = (
  graph: SurveyGraph,
  from: string,
  to: string,
  maxHops = 12,
  options: { readonly projected?: boolean } = {}
): ReadonlyArray<SurveyEdge> | undefined => {
  const walk = options.projected === true ? probeGraph(graph) : graph
  if (from === to) {
    return []
  }
  const forward = new Map<string, SurveyEdge | undefined>([[from, undefined]])
  const backward = new Map<string, SurveyEdge | undefined>([[to, undefined]])
  let frontF = [from]
  let frontB = [to]
  const join = (meet: string): ReadonlyArray<SurveyEdge> => {
    const head: Array<SurveyEdge> = []
    for (let edge = forward.get(meet); edge !== undefined; edge = forward.get(edge.from))
      head.unshift(edge)
    const tail: Array<SurveyEdge> = []
    for (let edge = backward.get(meet); edge !== undefined; edge = backward.get(edge.to))
      tail.push(edge)
    return [...head, ...tail]
  }
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (frontF.length <= frontB.length) {
      const next: Array<string> = []
      for (const id of frontF)
        for (const edge of walk.outgoing(id)) {
          if (!forward.has(edge.to)) {
            forward.set(edge.to, edge)
            next.push(edge.to)
          }
          if (backward.has(edge.to)) return join(edge.to)
        }
      frontF = next
    } else {
      const next: Array<string> = []
      for (const id of frontB)
        for (const edge of walk.incoming(id)) {
          if (!backward.has(edge.from)) {
            backward.set(edge.from, edge)
            next.push(edge.from)
          }
          if (forward.has(edge.from)) return join(edge.from)
        }
      frontB = next
    }
    if (frontF.length === 0 && frontB.length === 0) break
  }
  return undefined
}

export const pathBetween = (
  graph: SurveyGraph,
  a: string,
  b: string,
  maxHops = 12,
  options: { readonly projected?: boolean } = {}
): {
  readonly forward?: ReadonlyArray<SurveyEdge>
  readonly backward?: ReadonlyArray<SurveyEdge>
} => {
  const forward = shortestPath(graph, a, b, maxHops, options)
  const backward = shortestPath(graph, b, a, maxHops, options)
  return {
    ...(forward === undefined ? {} : { forward }),
    ...(backward === undefined ? {} : { backward })
  }
}

export const viewOfPath = (graph: SurveyGraph, path: ReadonlyArray<SurveyEdge>): GraphView => {
  const ids = new Set(path.flatMap((edge) => [edge.from, edge.to]))
  return { nodes: graph.nodes.filter((node) => ids.has(nodeId(node))), edges: path }
}

export const closureView = (graph: SurveyGraph, program: string, maxFiles: number): GraphView => {
  const projected = projectToFiles(graph)
  const paths = new Set([...closureFor(graph, program, maxFiles)])
  const ids = new Set(
    projected.nodes.filter((node) => node.name === program || paths.has(node.path)).map(nodeId)
  )
  return viewOf(projected, ids)
}

export const wholeView = (graph: SurveyGraph): GraphView => ({
  nodes: graph.nodes,
  edges: graph.edges
})

export interface GraphStats {
  readonly nodes: Readonly<Record<string, number>>
  readonly edges: Readonly<Record<string, number>>
  readonly origin: Readonly<Record<string, number>>
  readonly mechanism: Readonly<Record<string, number>>
  readonly confidence: Readonly<Record<string, number>>
  readonly unresolved: Readonly<Record<string, number>>
  readonly total: {
    readonly nodes: number
    readonly edges: number
    readonly unresolved: number
    readonly fills: number
  }
}

const tally = (keys: ReadonlyArray<string>): Readonly<Record<string, number>> =>
  keys.reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {})

export const graphStats = (graph: SurveyGraph): GraphStats => ({
  nodes: tally(graph.nodes.map(nodeKind)),
  edges: tally(graph.edges.map((edge) => edge.kind)),
  origin: tally(graph.edges.map(edgeOrigin)),
  mechanism: tally(graph.edges.map((edge) => edge.mechanism ?? "capture")),
  confidence: tally(graph.edges.map(edgeConfidence)),
  unresolved: tally(graph.unresolved.map((item) => item.reason)),
  total: {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    unresolved: graph.unresolved.length,
    fills: graph.fills.length
  }
})

/** An id, `<kind>:<name>` (first node of that kind with that name), or a bare file unit name. */
export const resolveNodeRef = (graph: SurveyGraph, ref: string): SurveyNode | undefined => {
  const exact = graph.node(ref)
  if (exact !== undefined) {
    return exact
  }
  const colon = ref.indexOf(":")
  if (colon > 0 && !ref.includes("#")) {
    const kind = ref.slice(0, colon)
    const name = ref.slice(colon + 1)
    return graph.nodes.find((node) => nodeKind(node) === kind && node.name === name)
  }
  return graph.nodes.find((node) => nodeKind(node) === "file" && node.name === ref)
}

export type ProbeStatus = "ok" | "broken" | "unknown-from" | "unknown-to"

export interface ProbeResult {
  readonly probe: ProbeRule
  readonly status: ProbeStatus
  readonly path?: ReadonlyArray<SurveyEdge>
}

export const probeResults = (
  graph: SurveyGraph,
  probes: ReadonlyArray<ProbeRule>,
  maxHops = 12
): ReadonlyArray<ProbeResult> => {
  const walk = probeGraph(graph)
  return probes.map((probe) => {
    const from = resolveNodeRef(graph, probe.from)
    const to = resolveNodeRef(graph, probe.to)
    if (from === undefined) return { probe, status: "unknown-from" }
    if (to === undefined) return { probe, status: "unknown-to" }
    const path = shortestPath(walk, nodeId(from), nodeId(to), maxHops)
    return path === undefined ? { probe, status: "broken" } : { probe, status: "ok", path }
  })
}
```

In `probeGraph`, the containment edge's `from` is the file unit of the node's path (`unitOfPath(node.path)`); simplify the ternary to that single expression.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/flow/test/GraphQuery.test.ts`
Expected: PASS. If `save-invoice` reports `broken`, print `probeGraph(graph).edges` filtered to `fattura`/`InvoiceServlet` and check that both the projected `jsp-form-action` edge and the raw `invokes-esb` edge are present.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/GraphQuery.ts packages/flow/package.json packages/flow/test/GraphQuery.test.ts
git commit -m "flow: graph queries — search, neighbourhood, bidirectional paths, stats, probes"
```

---

### Task 8: Rendering — mermaid, dot, text, entry paths, cluster diagrams

**Files:**

- Create: `packages/flow/src/GraphRender.ts`
- Modify: `packages/flow/package.json` (add `"./GraphRender": "./dist/GraphRender.js"`)
- Test: `packages/flow/test/GraphRender.test.ts` (create)

**Interfaces:**

- Produces:

  ```ts
  const mermaidNodeCap = 150
  const renderGraphMermaid: (
    view: GraphView,
    graph: SurveyGraph,
    options?: { cap?: number; force?: boolean }
  ) => string
  const renderGraphDot: (view: GraphView, graph: SurveyGraph) => string
  const renderGraphText: (view: GraphView) => string
  const renderEntryPaths: (
    graph: SurveyGraph,
    options?: { maxDepth?: number; maxLines?: number }
  ) => string
  const renderClusterDiagrams: (
    graph: SurveyGraph,
    consolidate: ConsolidateRules,
    programs: ReadonlyArray<string>,
    options?: { cap?: number }
  ) => string
  ```

- [ ] **Step 1: Write the failing tests**

````ts
// packages/flow/test/GraphRender.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { neighborhood, viewOfPath, probeResults, wholeView } from "@llm4ts/flow/GraphQuery"
import {
  renderClusterDiagrams,
  renderEntryPaths,
  renderGraphDot,
  renderGraphMermaid,
  renderGraphText
} from "@llm4ts/flow/GraphRender"
import { SurveyEdge, SurveyGraph, SurveyNode, buildCodeGraph } from "@llm4ts/flow/Survey"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { loadLegacyMiniPack, writeLegacyMini } from "./support/legacyMini.ts"

const built = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* writeLegacyMini(workspace)
  const pack = yield* loadLegacyMiniPack(workspace)
  const { graph } = yield* buildCodeGraph(workspace, {
    sources: pack.sources ?? ".*",
    coverage: pack.coverage,
    rules: pack.graph
  })
  return { graph, pack }
})

describe("graph rendering", () => {
  it.effect(
    "mermaid groups by file, styles kinds, dots inferred edges, flags unresolved, comments ids",
    () =>
      Effect.gen(function* () {
        const { graph } = yield* built
        const withLlm = SurveyGraph.make({
          ...graph,
          edges: [
            ...graph.edges,
            SurveyEdge.make({
              from: "OrphanServlet",
              to: "FEECALC",
              kind: "guess",
              origin: "llm",
              confidence: "inferred",
              mechanism: "llm"
            })
          ]
        })
        const view = neighborhood(
          withLlm,
          ["servlet-mapping:web/WEB-INF/web.xml#invoice", "OrphanServlet"],
          1
        )
        const mermaid = renderGraphMermaid(view, withLlm)
        assert.match(mermaid, /^flowchart LR/)
        assert.include(mermaid, 'subgraph f0["web/WEB-INF/web.xml"]')
        assert.include(mermaid, "classDef servlet-mapping")
        assert.include(mermaid, ":::unresolved") // OrphanServlet is isolated in the scanner graph
        assert.include(mermaid, "-.->|guess|")
        assert.include(mermaid, "-->|servlet-wiring|")
        assert.include(mermaid, "%% servlet-mapping:web/WEB-INF/web.xml#invoice")
        assert.notInclude(mermaid, '"${ctx}') // labels are escaped for mermaid
      })
  )

  it.effect("refuses an oversized mermaid unless forced and degrades to the text list", () =>
    Effect.gen(function* () {
      const nodes = Array.from({ length: 160 }, (_, index) =>
        SurveyNode.make({ path: `src/N${index}.cbl`, name: `N${index}`, lines: 1, units: 0 })
      )
      const graph = SurveyGraph.make({ nodes, edges: [] })
      const capped = renderGraphMermaid(wholeView(graph), graph)
      assert.include(capped, "160 nodes exceed the mermaid cap of 150")
      assert.include(capped, "N159")
      assert.notInclude(capped, "flowchart")
      const forced = renderGraphMermaid(wholeView(graph), graph, { force: true })
      assert.match(forced, /^flowchart LR/)
      const small = renderGraphMermaid(wholeView(graph), graph, { cap: 200 })
      assert.match(small, /^flowchart LR/)
    })
  )

  it.effect("dot and text emit the same view", () =>
    Effect.gen(function* () {
      const { graph, pack } = yield* built
      const path = probeResults(graph, pack.graph.probes)[0]!.path!
      const view = viewOfPath(graph, path)
      const dot = renderGraphDot(view, graph)
      assert.match(dot, /^digraph llm4ts \{/)
      assert.include(dot, 'subgraph "cluster_0"')
      assert.include(dot, 'label="jsp-form-action"')
      assert.include(dot, "shape=box")
      const text = renderGraphText(view)
      assert.include(text, "fattura -> InvoiceServlet [jsp-form-action]")
      assert.include(
        text,
        "InvoiceServlet -> esb-call:src/com/legacy/InvoiceServlet.java#SalvaFattura [invokes-esb]"
      )
    })
  )

  it.effect("entry paths and cluster diagrams for the inventory", () =>
    Effect.gen(function* () {
      const { graph, pack } = yield* built
      const paths = renderEntryPaths(graph)
      assert.include(paths, "fattura → InvoiceServlet (jsp-form-action)")
      assert.include(paths, "ACCTXFR → FEECALC (calls)")
      const clusters = renderClusterDiagrams(graph, pack.consolidate!, [
        "fattura",
        "invoice",
        "InvoiceServlet",
        "ReportServlet",
        "ACCTXFR",
        "FEECALC"
      ])
      assert.include(clusters, "## Cluster 1")
      assert.include(clusters, "```mermaid")
      assert.include(clusters, "InvoiceServlet")
    })
  )
})
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/flow/test/GraphRender.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `GraphRender.ts`**

````ts
// packages/flow/src/GraphRender.ts
import { clusterPrograms, type ConsolidateRules } from "./Domains.ts"
import { neighborhood, type GraphView } from "./GraphQuery.ts"
import {
  SurveyGraph,
  edgeConfidence,
  nodeId,
  nodeKind,
  nodeLabel,
  projectToFiles
} from "./Survey.ts"

export const mermaidNodeCap = 150

/** Reserved kinds get a fixed look; any pack-defined kind falls back to `neutral`. */
const styles: Readonly<Record<string, { readonly mermaid: string; readonly shape: string }>> = {
  file: { mermaid: "fill:#eef,stroke:#446,color:#000", shape: "box" },
  page: { mermaid: "fill:#efe,stroke:#464,color:#000", shape: "note" },
  "ajax-call": { mermaid: "fill:#ffe,stroke:#664,color:#000", shape: "ellipse" },
  form: { mermaid: "fill:#ffe,stroke:#664,color:#000", shape: "ellipse" },
  "servlet-mapping": { mermaid: "fill:#fee,stroke:#644,color:#000", shape: "hexagon" },
  "servlet-decl": { mermaid: "fill:#fee,stroke:#644,color:#000", shape: "hexagon" },
  "esb-call": { mermaid: "fill:#fdf,stroke:#646,color:#000", shape: "component" },
  "cobol-section": { mermaid: "fill:#eff,stroke:#466,color:#000", shape: "folder" },
  "cobol-paragraph": { mermaid: "fill:#eff,stroke:#466,color:#000", shape: "box" },
  neutral: { mermaid: "fill:#f4f4f4,stroke:#888,color:#000", shape: "box" }
}

const styleOf = (kind: string) => styles[kind] ?? styles.neutral!

const escapeMermaid = (text: string): string =>
  text.replaceAll('"', "'").replaceAll("$", "＄").replaceAll("{", "(").replaceAll("}", ")")
const escapeDot = (text: string): string => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

const unresolvedIds = (graph: SurveyGraph): ReadonlySet<string> =>
  new Set(graph.unresolved.map((item) => item.node))

const groupedByFile = (
  view: GraphView
): ReadonlyArray<readonly [string, ReadonlyArray<GraphView["nodes"][number]>]> => {
  const groups = new Map<string, Array<GraphView["nodes"][number]>>()
  for (const node of [...view.nodes].sort((a, b) => nodeId(a).localeCompare(nodeId(b)))) {
    groups.set(node.path, [...(groups.get(node.path) ?? []), node])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export const renderGraphText = (view: GraphView): string =>
  [
    ...groupedByFile(view).flatMap(([path, nodes]) => [
      path,
      ...nodes.map((node) => `  ${nodeId(node)} [${nodeKind(node)}]`)
    ]),
    "",
    ...view.edges.map(
      (edge) =>
        `${edge.from} -> ${edge.to} [${edge.kind}]${edgeConfidence(edge) === "inferred" ? " (inferred)" : ""}`
    )
  ].join("\n")

export const renderGraphMermaid = (
  view: GraphView,
  graph: SurveyGraph,
  options: { readonly cap?: number; readonly force?: boolean } = {}
): string => {
  const cap = options.cap ?? mermaidNodeCap
  if (view.nodes.length > cap && options.force !== true) {
    return [
      `${view.nodes.length} nodes exceed the mermaid cap of ${cap}; pass --force to render anyway. Text view:`,
      "",
      renderGraphText(view)
    ].join("\n")
  }
  const ids = new Map(view.nodes.map((node, index) => [nodeId(node), `n${index}`]))
  const flagged = unresolvedIds(graph)
  const kinds = [...new Set(view.nodes.map(nodeKind))]
  const lines = ["flowchart LR"]
  groupedByFile(view).forEach(([path, nodes], index) => {
    lines.push(`  subgraph f${index}["${escapeMermaid(path)}"]`)
    for (const node of nodes) {
      const id = nodeId(node)
      const cls = flagged.has(id) ? ":::unresolved" : `:::${nodeKind(node)}`
      lines.push(`    ${ids.get(id)}["${escapeMermaid(nodeLabel(node))}"]${cls} %% ${id}`)
    }
    lines.push("  end")
  })
  for (const edge of view.edges) {
    const arrow = edgeConfidence(edge) === "inferred" ? "-.->" : "-->"
    lines.push(`  ${ids.get(edge.from)} ${arrow}|${escapeMermaid(edge.kind)}| ${ids.get(edge.to)}`)
  }
  for (const kind of kinds) {
    lines.push(`  classDef ${kind} ${styleOf(kind).mermaid};`)
  }
  lines.push("  classDef unresolved fill:#fdd,stroke:#c00,color:#900;")
  return lines.join("\n")
}

export const renderGraphDot = (view: GraphView, graph: SurveyGraph): string => {
  const ids = new Map(view.nodes.map((node, index) => [nodeId(node), `n${index}`]))
  const flagged = unresolvedIds(graph)
  const lines = ["digraph llm4ts {", "  rankdir=LR;", "  node [fontname=Helvetica];"]
  groupedByFile(view).forEach(([path, nodes], index) => {
    lines.push(`  subgraph "cluster_${index}" {`, `    label="${escapeDot(path)}";`)
    for (const node of nodes) {
      const id = nodeId(node)
      const color = flagged.has(id) ? " color=red fontcolor=red" : ""
      lines.push(
        `    ${ids.get(id)} [label="${escapeDot(nodeLabel(node))}" shape=${styleOf(nodeKind(node)).shape} tooltip="${escapeDot(id)}"${color}];`
      )
    }
    lines.push("  }")
  })
  for (const edge of view.edges) {
    const style = edgeConfidence(edge) === "inferred" ? " style=dashed" : ""
    lines.push(
      `  ${ids.get(edge.from)} -> ${ids.get(edge.to)} [label="${escapeDot(edge.kind)}"${style}];`
    )
  }
  lines.push("}")
  return lines.join("\n")
}

/** From every projected node nothing points at, the chains it starts, depth-first, bounded. */
export const renderEntryPaths = (
  graph: SurveyGraph,
  options: { readonly maxDepth?: number; readonly maxLines?: number } = {}
): string => {
  const maxDepth = options.maxDepth ?? 4
  const maxLines = options.maxLines ?? 200
  const projected = projectToFiles(graph)
  const entries = projected.nodes.filter(
    (node) => projected.incoming(node.name).length === 0 && projected.outgoing(node.name).length > 0
  )
  const lines: Array<string> = []
  const walk = (id: string, trail: string, seen: ReadonlySet<string>, depth: number): void => {
    if (lines.length >= maxLines) return
    const out = projected.outgoing(id)
    if (out.length === 0 || depth === maxDepth) {
      lines.push(trail)
      return
    }
    for (const edge of out) {
      if (seen.has(edge.to)) {
        lines.push(`${trail} → ${edge.to} (${edge.kind}) ↺`)
        continue
      }
      walk(edge.to, `${trail} → ${edge.to} (${edge.kind})`, new Set([...seen, edge.to]), depth + 1)
    }
  }
  for (const entry of entries) walk(entry.name, entry.name, new Set([entry.name]), 0)
  return [
    "## Entry paths",
    "",
    ...(lines.length === 0 ? ["(none)"] : lines.map((line) => `- ${line}`)),
    ...(lines.length >= maxLines ? [`- … truncated at ${maxLines} lines`] : []),
    ""
  ].join("\n")
}

export const renderClusterDiagrams = (
  graph: SurveyGraph,
  consolidate: ConsolidateRules,
  programs: ReadonlyArray<string>,
  options: { readonly cap?: number } = {}
): string => {
  const projected = projectToFiles(graph)
  const clusters = clusterPrograms(graph, programs, consolidate).filter(
    (cluster) => cluster.programs.length > 1
  )
  if (clusters.length === 0) {
    return "## Clusters\n\n(no multi-program cluster)\n"
  }
  return [
    "## Clusters",
    "",
    ...clusters.flatMap((cluster, index) => [
      `### Cluster ${index + 1}: ${[...cluster.programs].sort().join(", ")}`,
      "",
      "```mermaid",
      renderGraphMermaid(neighborhood(projected, cluster.programs, 1), projected, {
        cap: options.cap ?? mermaidNodeCap
      }),
      "```",
      ""
    ])
  ].join("\n")
}
````

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/flow/test/GraphRender.test.ts`
Expected: PASS. `Cluster` from `Domains.ts` exposes `programs`; if the clusters test finds no multi-program cluster, confirm `clusterPrograms` received the projected edges (Task 4 Step 3).

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/GraphRender.ts packages/flow/package.json packages/flow/test/GraphRender.test.ts
git commit -m "flow: mermaid, dot and text renders of graph views, entry paths and cluster diagrams"
```

---

### Task 9: Pack manifests — j2ee and cobol vocabularies

**Files:**

- Modify: `kits/j2ee-nextjs/packs/j2ee-nextjs-spa/pack.md`, `kits/mainframe-java/packs/cobol-springboot/pack.md`, `kits/mainframe-java/packs/cobol-kafka/pack.md`
- Test: `kits/test/packs.test.ts` (update expectations), `flows/test/modernize-survey.smoke.test.ts` (J2EE expectations)

**Interfaces:**

- Consumes: the DSL from Task 2. No new code.

- [ ] **Step 1: Update the expectations first**

In `kits/test/packs.test.ts`, change the `j2ee-nextjs-spa` entry's `survey` list to `["jsp-include", "servlet-class"]` and add to the same entry:

```ts
    graph: {
      nodes: ["ajax-call", "form", "servlet-mapping", "servlet-decl"],
      joins: ["jsp-ajax-target", "jsp-form-action", "servlet-wiring"],
      probes: []
    },
```

and for both cobol entries:

```ts
    graph: { nodes: ["cobol-section", "cobol-paragraph"], edges: ["performs", "goes-to"], joins: [], probes: [] },
```

Extend the "carries compilable coverage and survey rules" case:

```ts
if ("graph" in expected) {
  assert.deepStrictEqual(
    pack.graph.nodes.map((rule) => rule.kind),
    [...expected.graph.nodes]
  )
  assert.deepStrictEqual(
    pack.graph.joins.map((rule) => rule.kind),
    [...expected.graph.joins]
  )
  if ("edges" in expected.graph) {
    assert.deepStrictEqual(
      pack.graph.edges
        .filter((rule) => rule.fromKind !== "file" || rule.toKind !== "file")
        .map((rule) => rule.kind),
      [...expected.graph.edges]
    )
  }
  for (const rule of [...pack.graph.nodes, ...pack.graph.edges]) {
    assert.doesNotThrow(() => new RegExp(rule.pattern, "gm"), `${rule.kind} pattern`)
  }
}
```

In `flows/test/modernize-survey.smoke.test.ts`, the J2EE expectations list becomes (keep the comment, fix its last sentence to say the form target now joins through `web.xml` and reaches the servlet by contraction):

```ts
;[
  "login->LoginServlet (jsp-form-action)",
  "login->footer (jsp-include)",
  "login->header (jsp-include)",
  "web->LoginServlet (servlet-class)"
]
```

Read `makeJ2eeEstate()` in that test first: if its `web.xml` maps `/login` to `LoginServlet` the projection yields exactly that edge; if the test estate has no `<servlet-mapping>` for `/login`, add one to the fixture's `web.xml` in the same test file so the join has something to hit. Keep every other assertion.

- [ ] **Step 2: Run the two tests to verify they fail**

Run: `pnpm vitest run kits/test/packs.test.ts flows/test/modernize-survey.smoke.test.ts`
Expected: FAIL on the new expectations.

- [ ] **Step 3: Edit the j2ee pack**

In `kits/j2ee-nextjs/packs/j2ee-nextjs-spa/pack.md` delete the `## Survey: jsp-form-action` and `## Survey: jsp-ajax-target` sections and add, after `## Survey: servlet-class`:

```markdown
## Node: ajax-call

files: ._\.(jsp|js)
pattern: (?:url:\s_|\$\.(?:get|post|getJSON)\(\s\*)['"](?<name>[^'"]+)['"]
attrs: url=name

## Node: form

files: ._\.jsp
pattern: <form[^>]_\baction="(?<name>[^"]+)"
attrs: url=name

## Node: servlet-mapping

files: ._web\.xml
pattern: <servlet-mapping>\s_<servlet-name>(?<name>[^<]+)</servlet-name>\s\*<url-pattern>(?<url>[^<]+)</url-pattern>
descriptor: yes

## Node: servlet-decl

files: ._web\.xml
pattern: <servlet>\s_<servlet-name>(?<name>[^<]+)</servlet-name>(?:(?!</servlet>)[\s\S])_?<servlet-class>(?:[a-z0-9_]+\.)_(?<class>[A-Za-z0-9_]+)</servlet-class>
descriptor: yes
anchor: class

## Join: jsp-ajax-target

from: ajax-call.url
to: servlet-mapping.url
match: url

## Join: jsp-form-action

from: form.url
to: servlet-mapping.url
match: url

## Join: servlet-wiring

from: servlet-mapping.name
to: servlet-decl.name
scope: file
```

`## Consolidate` is unchanged (`cluster: jsp-form-action, jsp-ajax-target`, `context: jsp-include`). Apply the same block to `jsp-nextjs` and `jsp-bff-nextjs` only if they have `## Survey:` sections for form or ajax targets; they currently have none, so leave them.

- [ ] **Step 4: Edit the cobol packs**

In both `cobol-springboot/pack.md` and `cobol-kafka/pack.md`, add after `## Survey: exec-pgm`:

```markdown
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
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run kits/test/packs.test.ts flows/test/modernize-survey.smoke.test.ts flows/test/modernize-pack-check.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add kits/j2ee-nextjs/packs/j2ee-nextjs-spa/pack.md kits/mainframe-java/packs/cobol-springboot/pack.md kits/mainframe-java/packs/cobol-kafka/pack.md kits/test/packs.test.ts flows/test/modernize-survey.smoke.test.ts
git commit -m "kits: j2ee pack joins ajax and forms to servlets through web.xml; cobol packs gain sections, PERFORM and GO TO"
```

---

### Task 10: `modernize-survey` reads through the cache and refines with the worklist

**Files:**

- Modify: `flows/modernize-survey.ts`
- Test: `flows/test/modernize-survey.smoke.test.ts`

**Interfaces:**

- Consumes: `freshGraph`, `updateGraphCache`, `graphCachePath` (Task 5); `worklistOf`, `worklistBatches`, `worklistPrompt`, `WorklistAnswer`, `worklistAnswerJsonSchema`, `verifyWorklistAnswer`, `mergeWorklist`, `renderWorklistReport` (Task 6); `renderGraphDot`, `renderEntryPaths`, `renderClusterDiagrams`, `wholeView` (Tasks 7–8).

- [ ] **Step 1: Update the smoke test's stub and assertions**

In the stub script inside `flows/test/modernize-survey.smoke.test.ts`, the refine branch currently keys on `"refining the dependency graph"`. Change it to key on `"resolving holes in the dependency graph"` and reply in the new shape for the COBOL estate:

```js
      ? cobol
        ? {
            edges: [
              {
                from: "RUNJOB",
                to: "ACCTXFR",
                kind: "dynamic-call",
                evidence: { file: "jobs/RUNJOB.jcl", line: 1, snippet: "//STEP1 EXEC PGM=&PGM" }
              }
            ],
            attrs: [],
            notes: ["CEE3ABD is a system service, not an estate unit"]
          }
        : { edges: [], attrs: [], notes: [] }
```

Check the COBOL fixture's `RUNJOB.jcl` content in the same file and make the snippet exactly the first line of it. Then change the COBOL assertions:

```ts
assert.deepStrictEqual(
  graph.edges
    .filter((edge) => edge.origin === "llm")
    .map((edge) => `${edge.from}->${edge.to} (${edge.kind})`),
  ["RUNJOB->ACCTXFR (dynamic-call)"]
)
const refine = read("graph-refine.md")
assert.include(refine, "1 edge(s) and 0 attr fill(s) accepted")
assert.include(refine, "EXEC PGM=&PGM")
assert.include(refine, "CEE3ABD")
assert.include(read("inventory.md"), "## Entry paths")
assert.isTrue(existsSync(join(modDir, "graph.dot")))
assert.isTrue(existsSync(join(estate.root, "estate", ".llm4ts", "graph", "smoke.json")))
```

Replace `"smoke"` with the COBOL fixture pack's name as `makeEstate()` writes it. For the worklist to contain `RUNJOB` the COBOL fixture must leave something unresolved on it: `RUNJOB.jcl` has `EXEC PGM=&PGM`, which `exec-pgm` does not capture, so `RUNJOB` is `isolated` and offered. Keep the `surveyTriagePrompt` branch of the stub unchanged.

- [ ] **Step 2: Run the smoke test to verify it fails**

Run: `pnpm vitest run flows/test/modernize-survey.smoke.test.ts`
Expected: FAIL — the flow still sends the old refine prompt and writes no `graph.dot`.

- [ ] **Step 3: Rewrite the graph and refine stages**

In `flows/modernize-survey.ts`:

Imports: drop `SurveyEdge`, `mergeSurveyEdges`, `surveyRefinePrompt` and the `RefinedEdge`/`GraphRefinement`/`graphRefinementJsonSchema`/`renderRefine` definitions; add

```ts
import { freshGraph, graphCachePath, updateGraphCache } from "@llm4ts/flow/GraphCache"
import {
  WorklistAnswer,
  mergeWorklist,
  renderWorklistReport,
  verifyWorklistAnswer,
  worklistAnswerJsonSchema,
  worklistBatches,
  worklistOf,
  worklistPrompt,
  type VerifiedWorklist
} from "@llm4ts/flow/GraphWorklist"
import { wholeView } from "@llm4ts/flow/GraphQuery"
import { renderClusterDiagrams, renderEntryPaths, renderGraphDot } from "@llm4ts/flow/GraphRender"
```

Replace the `pack.survey.length === 0` abort condition with `pack.survey.length === 0 && pack.graph.edges.length === 0 && pack.graph.joins.length === 0` and the message with "has no '## Survey:', '## Edge:' or '## Join:' sections".

Graph stage body:

```ts
const cachePath = graphCachePath(input.workDir, pack.name)
const fresh =
  yield *
  freshGraph(nodePlainFileStore, cachePath, pack, repo).pipe(
    Effect.catchTag("WorkspaceLimit", (error) =>
      Effect.fail(
        error.operation === "discovery results"
          ? FlowAborted.make({ message: `${input.workDir}: ${discoveryOverflowAdvice(limits)}` })
          : error
      )
    )
  )
yield * writeGraphArtifacts(repo, pack, fresh.graph)
yield *
  context.events.publish(
    Info.make({
      message:
        `${fresh.graph.nodes.length} node(s), ${fresh.graph.edges.length} edge(s), ${fresh.graph.unresolved.length} unresolved` +
        (fresh.reused ? " (graph cache reused)" : "")
    })
  )
return fresh
```

with a module-level helper:

```ts
const writeGraphArtifacts = (repo: WorkspaceShape, pack: Pack, graph: SurveyGraph) =>
  Effect.gen(function* () {
    const programs = graph.nodes
      .filter((node) => (node.kind ?? "file") === "file")
      .map((node) => node.name)
    const inventory = [
      renderSurveyInventory(graph),
      renderClusterDiagrams(graph, pack.consolidate ?? { cluster: [], context: [] }, programs),
      renderEntryPaths(graph)
    ].join("\n")
    yield* repo.write(join(ModDir, "inventory.md"), inventory)
    yield* repo.write(join(ModDir, "graph.json"), renderSurveyGraphJson(graph))
    yield* repo.write(join(ModDir, "graph.dot"), renderGraphDot(wholeView(graph), graph))
  })
```

(import `Pack` from `@llm4ts/flow/Pack`, `WorkspaceShape` from `@llm4ts/flow/Workspace`, `SurveyGraph` type from `@llm4ts/flow/Survey`.)

Refine stage body (the non-disabled branch):

```ts
            : Effect.gen(function* () {
                const read = (path: string): string | undefined => contentsCache.get(path)
                const contentsCache = new Map<string, string>()
                for (const path of new Set(fresh.graph.unresolved.map((item) => item.file))) {
                  contentsCache.set(path, yield* repo.read(path).pipe(Effect.orElseSucceed(() => "")))
                }
                const items = worklistOf(fresh.graph, read, pack.graph.worklistMax)
                if (items.length === 0) {
                  yield* context.events.publish(Info.make({ message: "nothing unresolved — no LLM pass needed" }))
                  return fresh.graph
                }
                let graph = fresh.graph
                const accepted: Array<VerifiedWorklist> = []
                const notes: Array<string> = []
                for (const batch of worklistBatches(items, pack.graph.batchSize)) {
                  const answer = yield* withShrink("graph worklist", (cap) =>
                    Effect.gen(function* () {
                      const prompt = yield* capped("worklist", worklistPrompt(batch, pack.prompt("survey-refine")), cap)
                      return yield* structuredAndPublish(context.reasoning, context.events, prompt, WorklistAnswer, worklistAnswerJsonSchema)
                    })
                  ).pipe(Effect.provideService(FlowEvents, context.events))
                  const verified = verifyWorklistAnswer(answer, graph, (path) =>
                    contentsCache.get(path)
                  )
                  for (const file of new Set([...answer.edges.map((e) => e.evidence.file), ...answer.attrs.map((a) => a.evidence.file)])) {
                    if (!contentsCache.has(file)) {
                      contentsCache.set(file, yield* repo.read(file).pipe(Effect.orElseSucceed(() => "")))
                    }
                  }
                  const reverified = verifyWorklistAnswer(answer, graph, read)
                  graph = mergeWorklist(graph, reverified, pack.graph)
                  accepted.push(reverified)
                  notes.push(...answer.notes)
                }
                const all: VerifiedWorklist = {
                  edges: accepted.flatMap((v) => v.edges),
                  fills: accepted.flatMap((v) => v.fills),
                  dropped: accepted.flatMap((v) => v.dropped)
                }
                yield* repo.write(join(ModDir, "graph-refine.md"), renderWorklistReport(items, all, notes))
                yield* updateGraphCache(nodePlainFileStore, cachePath, fresh.cache, graph)
                yield* writeGraphArtifacts(repo, pack, graph)
                yield* context.events.publish(
                  Info.make({ message: `${all.edges.length} edge(s) and ${all.fills.length} fill(s) accepted from ${items.length} unresolved item(s); ${all.dropped.length} dropped` })
                )
                return graph
              })
```

Simplify: declare `contentsCache` before `read`, and drop the first `verifyWorklistAnswer` call (keep only `reverified`, after the evidence files are loaded). The triage stage keeps calling `surveyTriagePrompt(refined, renderSurveyInventory(refined), …)` unchanged; `refined` is now the merged graph. The `renderRefine`/`tableCell` helpers are removed if nothing else uses them (`tableCell` is still used by `renderWavePlan`; keep it).

- [ ] **Step 4: Run the smoke tests**

Run: `pnpm vitest run flows/test/modernize-survey.smoke.test.ts flows/test/modernize-pipeline.smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flows/modernize-survey.ts flows/test/modernize-survey.smoke.test.ts
git commit -m "modernize-survey: cached graph, worklist refine with verified evidence, diagrams and entry paths"
```

---

### Task 11: Extract, refine and convert read the persisted graph; extract embeds the closure diagram

**Files:**

- Modify: `flows/modernize-extract.ts`, `flows/modernize-refine.ts`, `kits/j2ee-nextjs/flows/lib/convert.ts`
- Test: `flows/test/modernize-extract-wave.smoke.test.ts`, `kits/j2ee-nextjs/test/convert.test.ts` (one assertion each)

**Interfaces:**

- Consumes: `freshGraph`, `graphCachePath`; `closureView`, `renderGraphMermaid`; `mermaidDocument` from `@llm4ts/flow/Mermaid` is **not** used (no mermaid.ink link in a spec).

- [ ] **Step 1: Add the assertions**

In `flows/test/modernize-extract-wave.smoke.test.ts`, where a written spec is read, add:

````ts
assert.include(spec, "## Dependency closure")
assert.include(spec, "```mermaid")
````

In `kits/j2ee-nextjs/test/convert.test.ts`, in the test that exercises `legacyEvidence` (or the first test that runs a page conversion against a legacy workspace), assert that a second run reports the graph cache as reused by checking the cache file exists: `assert.isTrue(existsSync(join(legacyDir, ".llm4ts", "graph", pack.name + ".json")))`. If the test's legacy workspace is in memory, assert instead through the memory store passed as `deps.files`: `assert.isDefined(yield* deps.files.read(graphCachePath(deps.legacyDir, deps.pack.name)))`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run flows/test/modernize-extract-wave.smoke.test.ts kits/j2ee-nextjs/test/convert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Switch the three readers to `freshGraph`**

`flows/modernize-extract.ts` graph stage:

```ts
const graph =
  yield *
  stage(
    context.events,
    "graph",
    pack.survey.length === 0 && pack.graph.edges.length === 0 && pack.graph.joins.length === 0
      ? context.events
          .publish(
            Info.make({ message: "pack has no graph rules — the analyst gets no resolved closure" })
          )
          .pipe(Effect.as(SurveyGraph.make({ nodes: [], edges: [] })))
      : freshGraph(files, graphCachePath(input.workDir, pack.name), pack, repo).pipe(
          Effect.tap((fresh) =>
            context.events.publish(
              Info.make({
                message: fresh.reused
                  ? "graph cache reused"
                  : "graph rebuilt (scanner layer); LLM edges carried where their evidence is unchanged"
              })
            )
          ),
          Effect.map((fresh) => fresh.graph)
        )
  )
```

and in the analyst callback, wrap the result so the closure diagram is prepended:

```ts
return (
  yield *
  structuredAndPublish(/* unchanged args */).pipe(
    Effect.map((artifacts) =>
      ProgramArtifacts.make({
        ...artifacts,
        spec: `${closureSection(graph, target.name)}\n\n${artifacts.spec}`
      })
    )
    /* existing catchIf unchanged */
  )
)
```

with, in `flows/lib/modernize-extract.ts`:

```ts
import { closureView } from "@llm4ts/flow/GraphQuery"
import { renderGraphMermaid } from "@llm4ts/flow/GraphRender"
import type { SurveyGraph } from "@llm4ts/flow/Survey"

/** The program's bounded closure as a diagram, placed above the analyst's spec. */
export const closureSection = (graph: SurveyGraph, program: string): string => {
  const view = closureView(graph, program, maxClosureFiles())
  return view.edges.length === 0
    ? "## Dependency closure\n\n(no resolved dependencies)"
    : `## Dependency closure\n\n\`\`\`mermaid\n${renderGraphMermaid(view, graph)}\n\`\`\``
}
```

Apply the same `freshGraph` replacement in `flows/modernize-refine.ts` (its `files` and `repo` already exist) and in `kits/j2ee-nextjs/flows/lib/convert.ts` at both `surveyGraph(...)` call sites:

```ts
const graph = (
  yield *
  freshGraph(deps.files, graphCachePath(deps.legacyDir, deps.pack.name), deps.pack, deps.legacy)
).graph
```

Import `freshGraph, graphCachePath` from `@llm4ts/flow/GraphCache` in each; remove the now-unused `surveyGraph` imports.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run flows/test kits/j2ee-nextjs/test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flows/modernize-extract.ts flows/modernize-refine.ts flows/lib/modernize-extract.ts kits/j2ee-nextjs/flows/lib/convert.ts flows/test/modernize-extract-wave.smoke.test.ts kits/j2ee-nextjs/test/convert.test.ts
git commit -m "modernize-extract/refine, convert: read the cached graph; specs open with the closure diagram"
```

---

### Task 12: `modernize-pack-check` reports graph rules, unresolved items and probes

**Files:**

- Modify: `flows/modernize-pack-check.ts`
- Test: `flows/test/modernize-pack-check.test.ts`

**Interfaces:**

- Consumes: `buildCodeGraph`, `graphStats`, `probeResults`.

- [ ] **Step 1: Add a test**

```ts
it("reports node, edge and join rules, the unresolved list and probe verdicts; a broken probe fails", () => {
  const fixture = makeFixture()
  cobolEstate(fixture.legacy)
  write(
    fixture.root,
    "packs/graph/pack.md",
    [
      "# Pack: graph",
      "",
      "source: cobol",
      "sources: .*\\.(cbl|jcl)",
      "",
      "## Survey: calls",
      "files: .*\\.cbl",
      "unit: CALL '([A-Z0-9]+)'",
      "",
      "## Node: cobol-paragraph",
      "files: .*\\.cbl",
      "pattern: ^ {7}(?<name>\\d{4}-[A-Z0-9-]+)\\.",
      "",
      "## Edge: performs",
      "files: .*\\.cbl",
      "pattern: PERFORM +(?<to>\\d{4}-[A-Z0-9-]+)",
      "from: cobol-paragraph",
      "to: cobol-paragraph",
      "",
      "## Probe: transfer",
      "from: ACCTXFR",
      "to: FEECALC",
      "",
      "## Probe: ghost",
      "from: ACCTXFR",
      "to: NOWHERE",
      ""
    ].join("\n")
  )
  const result = runFlow(fixture, "modernize-pack-check", fixture.legacy, {
    LLM4TS_PACK: "packs/graph"
  })
  const output = `${result.stdout}${result.stderr}`
  assert.notStrictEqual(result.status, 0, "a broken probe must fail the check")
  assert.include(output, "node 'cobol-paragraph': 3 nodes")
  assert.include(output, "edge 'performs': 0 edges")
  assert.include(output, "unresolved: ")
  assert.include(output, "edge-target")
  assert.include(output, "probe 'transfer': ok (ACCTXFR → FEECALC via calls)")
  assert.include(output, "probe 'ghost': unknown-to")
})
```

Keep the existing cases; the "typo" case's warning count stays 11 only if no new warning fires for a pack without graph sections, which is the intent: an absent `## Node:` is not a warning.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run flows/test/modernize-pack-check.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the estate stage**

After `yield* report("survey", pack.survey)` add:

```ts
const build =
  yield *
  buildCodeGraph(repo, {
    sources: sourcesRegex,
    ...(pack.exclude === undefined ? {} : { exclude: pack.exclude }),
    coverage: pack.coverage,
    rules: pack.graph
  })
const stats = graphStats(build.graph)
for (const rule of pack.graph.nodes) {
  const count = stats.nodes[rule.kind] ?? 0
  const samples = build.graph.nodes
    .filter((node) => node.kind === rule.kind)
    .map((node) => node.name)
  yield * say(`node '${rule.kind}': ${plural(count, "node")} — ${sample(samples)}`)
  if (count === 0)
    warnings.push(
      `node rule '${rule.kind}' matched nothing: files '${rule.files}', pattern '${rule.pattern}'`
    )
}
const duplicates = build.graph.nodes.filter((node) => (node.id ?? "").includes("~"))
if (duplicates.length > 0) {
  warnings.push(
    `${plural(duplicates.length, "node")} share a name within one file (ids with '~n'): ${sample(duplicates.map((node) => node.id ?? node.name))}`
  )
}
for (const rule of pack.graph.edges.filter(
  (rule) => rule.fromKind !== "file" || rule.toKind !== "file"
)) {
  const count = stats.edges[rule.kind] ?? 0
  yield * say(`edge '${rule.kind}': ${plural(count, "edge")}`)
  if (count === 0) warnings.push(`edge rule '${rule.kind}' produced no edge`)
}
for (const rule of pack.graph.joins) {
  const count = build.graph.edges.filter(
    (edge) => edge.kind === rule.kind && (edge.mechanism ?? "").startsWith("join:")
  ).length
  yield *
    say(
      `join '${rule.kind}' (${rule.fromKind}.${rule.fromAttr} → ${rule.toKind}.${rule.toAttr}, ${rule.match}, scope ${rule.scope}): ${plural(count, "edge")}`
    )
  if (count === 0) warnings.push(`join '${rule.kind}' produced no edge`)
}
const byReason = Object.entries(stats.unresolved)
  .map(([reason, count]) => `${reason} ${count}`)
  .join(", ")
yield * say(`unresolved: ${build.graph.unresolved.length === 0 ? "none" : byReason}`)
for (const item of build.graph.unresolved.slice(0, 20)) {
  yield *
    say(
      `  ${item.reason} [${item.rule}] ${item.node}${item.reference === undefined ? "" : ` → ${item.reference}`} (${item.file}:${item.line})`
    )
}
for (const result of probeResults(build.graph, pack.graph.probes)) {
  const via =
    result.path === undefined
      ? ""
      : ` (${result.path.length === 0 ? "same node" : `${probeFrom(result.path)} → ${probeTo(result.path)} via ${result.path.map((edge) => edge.kind).join(" → ")}`})`
  yield * say(`probe '${result.probe.name}': ${result.status}${via}`)
  if (result.status !== "ok")
    failures.push(
      `probe '${result.probe.name}' is ${result.status} (${result.probe.from} → ${result.probe.to})`
    )
}
```

with two one-line helpers at module level: `const probeFrom = (path) => path[0]?.from ?? ""` and `const probeTo = (path) => path.at(-1)?.to ?? ""`, typed over `ReadonlyArray<SurveyEdge>`. Update the header comment of the flow to list the new report lines and that a broken probe is a failure. Imports: `buildCodeGraph` and `SurveyEdge` from `@llm4ts/flow/Survey`, `graphStats, probeResults` from `@llm4ts/flow/GraphQuery`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run flows/test/modernize-pack-check.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add flows/modernize-pack-check.ts flows/test/modernize-pack-check.test.ts
git commit -m "modernize-pack-check: graph rule counts, unresolved list and probe verdicts without a model"
```

---

### Task 13: Runner program `@llm4ts/runner/Graph`

**Files:**

- Create: `packages/runner/src/Graph.ts`
- Modify: `packages/runner/package.json` (add `"./Graph": "./dist/Graph.js"`)
- Test: `packages/runner/test/Graph.test.ts` (create)

**Interfaces:**

- Produces:

  ```ts
  type GraphFormat = "text" | "json" | "mermaid" | "dot"
  type GraphCommand =
    | { readonly _tag: "build"; readonly repo: string; readonly pack?: string }
    | {
        readonly _tag: "query"
        readonly repo: string
        readonly pack?: string
        readonly text: string
        readonly kind?: string
        readonly hops: number
        readonly format: GraphFormat
        readonly all: boolean
        readonly force: boolean
      }
    | {
        readonly _tag: "path"
        readonly repo: string
        readonly pack?: string
        readonly from: string
        readonly to: string
        readonly max: number
        readonly format: GraphFormat
        readonly force: boolean
      }
    | {
        readonly _tag: "closure"
        readonly repo: string
        readonly pack?: string
        readonly program: string
        readonly max: number
        readonly format: GraphFormat
        readonly force: boolean
      }
    | {
        readonly _tag: "stats"
        readonly repo: string
        readonly pack?: string
        readonly format: GraphFormat
      }
    | {
        readonly _tag: "probe"
        readonly repo: string
        readonly pack?: string
        readonly format: GraphFormat
      }
  interface GraphDependencies {
    readonly files: PlainFileStoreShape
    readonly workspace: (root: string) => Effect.Effect<WorkspaceShape, WorkspaceError>
    readonly openPack: (
      repo: string,
      pack: string | undefined
    ) => Effect.Effect<Pack, FlowError | PackNotFound | WorkspaceError>
  }
  const makeGraphProgram: (
    command: GraphCommand,
    deps: GraphDependencies
  ) => Effect.Effect<string, FlowError | PackNotFound | WorkspaceError>
  const nodeGraphDependencies: (
    environment: Readonly<Record<string, string | undefined>>,
    kits: KitTierPaths
  ) => GraphDependencies
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/runner/test/Graph.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { makeGraphProgram, type GraphDependencies } from "@llm4ts/runner/Graph"
import { loadLegacyMiniPack, writeLegacyMini } from "../../flow/test/support/legacyMini.ts"

const deps = Effect.gen(function* () {
  const estate = yield* makeMemoryWorkspace({ root: "/estate" })
  yield* writeLegacyMini(estate)
  const packs = yield* makeMemoryWorkspace({ root: "/packs" })
  const pack = yield* loadLegacyMiniPack(packs)
  const memory = yield* makeMemoryPlainFileStore()
  const dependencies: GraphDependencies = {
    files: memory.store,
    workspace: () => Effect.succeed(estate),
    openPack: () => Effect.succeed(pack)
  }
  return { dependencies, files: memory.store }
})

describe("llm4ts graph", () => {
  it.effect("build writes the cache and reports stats; later commands read it", () =>
    Effect.gen(function* () {
      const { dependencies, files } = yield* deps
      const built = yield* makeGraphProgram({ _tag: "build", repo: "/estate" }, dependencies)
      assert.include(built, "nodes:")
      assert.include(built, "unresolved:")
      assert.isDefined(yield* files.read("/estate/.llm4ts/graph/legacy-mini.json"))

      const stats = yield* makeGraphProgram(
        { _tag: "stats", repo: "/estate", format: "json" },
        dependencies
      )
      assert.strictEqual(JSON.parse(stats).edges["servlet-wiring"], 3)

      const query = yield* makeGraphProgram(
        {
          _tag: "query",
          repo: "/estate",
          text: "salvaFattura",
          hops: 1,
          format: "text",
          all: false,
          force: false
        },
        dependencies
      )
      assert.include(query, "servlet-mapping:web/WEB-INF/web.xml#invoice")
      assert.include(query, "servlet-decl:web/WEB-INF/web.xml#invoice")

      const path = yield* makeGraphProgram(
        {
          _tag: "path",
          repo: "/estate",
          from: "fattura",
          to: "esb-call:SalvaFattura",
          max: 8,
          format: "mermaid",
          force: false
        },
        dependencies
      )
      assert.match(path, /^flowchart LR/)
      assert.include(path, "invokes-esb")

      const closure = yield* makeGraphProgram(
        {
          _tag: "closure",
          repo: "/estate",
          program: "fattura",
          max: 10,
          format: "dot",
          force: false
        },
        dependencies
      )
      assert.match(closure, /^digraph llm4ts/)

      const probes = yield* makeGraphProgram(
        { _tag: "probe", repo: "/estate", format: "text" },
        dependencies
      )
      assert.include(probes, "save-invoice: ok")
      assert.include(probes, "orphan: broken")
    })
  )

  it.effect("an unknown node reference is a readable failure, not a crash", () =>
    Effect.gen(function* () {
      const { dependencies } = yield* deps
      const error = yield* Effect.flip(
        makeGraphProgram(
          {
            _tag: "path",
            repo: "/estate",
            from: "ghost",
            to: "fattura",
            max: 8,
            format: "text",
            force: false
          },
          dependencies
        )
      )
      assert.include(String(error), "ghost")
    })
  )
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/runner/test/Graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `Graph.ts`**

```ts
// packages/runner/src/Graph.ts
import { homedir } from "node:os"
import * as Effect from "effect/Effect"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import { freshGraph, graphCachePath } from "@llm4ts/flow/GraphCache"
import {
  closureView,
  graphStats,
  neighborhood,
  pathBetween,
  probeResults,
  resolveNodeRef,
  searchNodes,
  viewOfPath,
  wholeView,
  type GraphView
} from "@llm4ts/flow/GraphQuery"
import { renderGraphDot, renderGraphMermaid, renderGraphText } from "@llm4ts/flow/GraphRender"
import type { Pack } from "@llm4ts/flow/Pack"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { nodeId, type SurveyGraph } from "@llm4ts/flow/Survey"
import {
  legacySourceWorkspaceLimits,
  workspaceLimitsFromEnv,
  type WorkspaceError,
  type WorkspaceShape
} from "@llm4ts/flow/Workspace"
import { kitTierPaths, type KitTierPaths } from "./Kits.ts"
import { nodePlainFileStore } from "./NodePlainFileStore.ts"
import { makeNodeWorkspace } from "./NodeWorkspace.ts"
import { openPack, type PackNotFound } from "./Packs.ts"

export type GraphFormat = "text" | "json" | "mermaid" | "dot"

export type GraphCommand =
  | { readonly _tag: "build"; readonly repo: string; readonly pack?: string }
  | {
      readonly _tag: "query"
      readonly repo: string
      readonly pack?: string
      readonly text: string
      readonly kind?: string
      readonly hops: number
      readonly format: GraphFormat
      readonly all: boolean
      readonly force: boolean
    }
  | {
      readonly _tag: "path"
      readonly repo: string
      readonly pack?: string
      readonly from: string
      readonly to: string
      readonly max: number
      readonly format: GraphFormat
      readonly force: boolean
    }
  | {
      readonly _tag: "closure"
      readonly repo: string
      readonly pack?: string
      readonly program: string
      readonly max: number
      readonly format: GraphFormat
      readonly force: boolean
    }
  | {
      readonly _tag: "stats"
      readonly repo: string
      readonly pack?: string
      readonly format: GraphFormat
    }
  | {
      readonly _tag: "probe"
      readonly repo: string
      readonly pack?: string
      readonly format: GraphFormat
    }

export interface GraphDependencies {
  readonly files: PlainFileStoreShape
  readonly workspace: (root: string) => Effect.Effect<WorkspaceShape, WorkspaceError>
  readonly openPack: (
    repo: string,
    pack: string | undefined
  ) => Effect.Effect<Pack, FlowError | PackNotFound | WorkspaceError>
}

const render = (
  view: GraphView,
  graph: SurveyGraph,
  format: GraphFormat,
  force: boolean
): string => {
  switch (format) {
    case "json":
      return JSON.stringify(view, undefined, 2)
    case "mermaid":
      return renderGraphMermaid(view, graph, { force })
    case "dot":
      return renderGraphDot(view, graph)
    default:
      return renderGraphText(view)
  }
}

const requireNode = (graph: SurveyGraph, ref: string) =>
  Effect.fromNullable(resolveNodeRef(graph, ref)).pipe(
    Effect.mapError(() =>
      FlowAborted.make({ message: `no node matches '${ref}' (try: llm4ts graph query "${ref}")` })
    )
  )

const load = (command: GraphCommand, deps: GraphDependencies) =>
  Effect.gen(function* () {
    const pack = yield* deps.openPack(command.repo, command.pack)
    const workspace = yield* deps.workspace(command.repo)
    const fresh = yield* freshGraph(
      deps.files,
      graphCachePath(command.repo, pack.name),
      pack,
      workspace
    )
    return { pack, ...fresh }
  })

export const makeGraphProgram = Effect.fn("@llm4ts/runner/Graph.make")(function* (
  command: GraphCommand,
  deps: GraphDependencies
): Effect.fn.Return<string, FlowError | PackNotFound | WorkspaceError> {
  const { pack, graph, reused } = yield* load(command, deps)
  switch (command._tag) {
    case "build": {
      const stats = graphStats(graph)
      return [
        `pack ${pack.name} — graph ${reused ? "reused from" : "written to"} ${graphCachePath(command.repo, pack.name)}`,
        `nodes: ${stats.total.nodes} (${Object.entries(stats.nodes)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ")})`,
        `edges: ${stats.total.edges} (${Object.entries(stats.edges)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ")})`,
        `unresolved: ${stats.total.unresolved} (${
          Object.entries(stats.unresolved)
            .map(([k, n]) => `${k} ${n}`)
            .join(", ") || "none"
        })`
      ].join("\n")
    }
    case "stats": {
      const stats = graphStats(graph)
      return command.format === "json"
        ? JSON.stringify(stats, undefined, 2)
        : [
            "kind\tcount",
            ...Object.entries(stats.nodes).map(([k, n]) => `node ${k}\t${n}`),
            ...Object.entries(stats.edges).map(([k, n]) => `edge ${k}\t${n}`),
            ...Object.entries(stats.mechanism).map(([k, n]) => `mechanism ${k}\t${n}`),
            ...Object.entries(stats.origin).map(([k, n]) => `origin ${k}\t${n}`),
            ...Object.entries(stats.unresolved).map(([k, n]) => `unresolved ${k}\t${n}`)
          ].join("\n")
    }
    case "query": {
      const hits = searchNodes(
        graph,
        command.text,
        command.kind === undefined ? {} : { kind: command.kind }
      )
      if (hits.length === 0) {
        return `no node matches '${command.text}'`
      }
      const view = command.all
        ? wholeView(graph)
        : neighborhood(
            graph,
            hits.map((hit) => nodeId(hit.node)),
            command.hops
          )
      return render(view, graph, command.format, command.force)
    }
    case "path": {
      const from = yield* requireNode(graph, command.from)
      const to = yield* requireNode(graph, command.to)
      const found = pathBetween(graph, nodeId(from), nodeId(to), command.max, { projected: true })
      const path = found.forward ?? found.backward
      if (path === undefined) {
        return `no path within ${command.max} hops between ${nodeId(from)} and ${nodeId(to)} in either direction`
      }
      const direction =
        found.forward === undefined ? `(reverse: ${nodeId(to)} → ${nodeId(from)})\n` : ""
      return `${direction}${render(viewOfPath(graph, path), graph, command.format, command.force)}`
    }
    case "closure":
      return render(
        closureView(graph, command.program, command.max),
        graph,
        command.format,
        command.force
      )
    case "probe": {
      const results = probeResults(graph, pack.graph.probes)
      return command.format === "json"
        ? JSON.stringify(
            results.map((r) => ({ name: r.probe.name, status: r.status, hops: r.path?.length })),
            undefined,
            2
          )
        : results.length === 0
          ? `pack ${pack.name} declares no '## Probe:' section`
          : results
              .map(
                (r) =>
                  `${r.probe.name}: ${r.status}${r.path === undefined ? "" : ` via ${r.path.map((e) => e.kind).join(" → ")}`}`
              )
              .join("\n")
    }
  }
})

export const nodeGraphDependencies = (
  environment: Readonly<Record<string, string | undefined>>,
  kits: KitTierPaths
): GraphDependencies => ({
  files: nodePlainFileStore,
  workspace: (root) =>
    makeNodeWorkspace(root, workspaceLimitsFromEnv(environment, legacySourceWorkspaceLimits)),
  openPack: (repo, pack) =>
    openPack({
      environment: { ...environment, ...(pack === undefined ? {} : { LLM4TS_PACK: pack }) },
      launchDir: repo,
      flowDir: repo,
      kits:
        kits.builtin === undefined
          ? kitTierPaths({ cwd: repo, homeDir: homedir(), environment })
          : kits
    }).pipe(Effect.map((opened) => opened.pack))
})
```

If `openPack`'s error union differs from `FlowError | PackNotFound | WorkspaceError`, widen `GraphDependencies.openPack`'s error type to match it exactly rather than casting.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/runner/test/Graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/Graph.ts packages/runner/package.json packages/runner/test/Graph.test.ts
git commit -m "runner: llm4ts graph program — build, query, path, closure, stats, probe"
```

---

### Task 14: Shell verb `llm4ts graph`

**Files:**

- Modify: `packages/shell/src/Cli.ts`
- Test: `packages/shell/test/Cli.test.ts`

**Interfaces:**

- Produces: `graphCommandFrom(sub: "build"|"query"|"path"|"closure"|"stats"|"probe", config, cwd): Effect<GraphCommand, ShellUsageError>` exported for tests; `graphCommand` registered in `withSubcommands`.

- [ ] **Step 1: Write the failing test**

Add to `packages/shell/test/Cli.test.ts` (import `graphCommandFrom` from `@llm4ts/shell/Cli`):

```ts
describe("graphCommandFrom", () => {
  const base = {
    repo: Option.none(),
    pack: Option.none(),
    format: "text",
    kind: Option.none(),
    hops: "1",
    max: "12",
    all: false,
    force: false
  }
  it.effect("resolves the repo, parses numbers and validates the format", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* graphCommandFrom("build", base, "/work"), {
        _tag: "build",
        repo: "/work"
      })
      assert.deepStrictEqual(
        yield* graphCommandFrom(
          "query",
          {
            ...base,
            repo: Option.some("../estate"),
            text: "salva",
            format: "mermaid",
            hops: "2",
            kind: Option.some("form")
          },
          "/work/llm4ts"
        ),
        {
          _tag: "query",
          repo: "/work/estate",
          text: "salva",
          kind: "form",
          hops: 2,
          format: "mermaid",
          all: false,
          force: false
        }
      )
      assert.deepStrictEqual(
        yield* graphCommandFrom(
          "path",
          { ...base, from: "a", to: "b", max: "6", format: "dot" },
          "/w"
        ),
        { _tag: "path", repo: "/w", from: "a", to: "b", max: 6, format: "dot", force: false }
      )
      const bad = yield* Effect.flip(graphCommandFrom("stats", { ...base, format: "svg" }, "/w"))
      assert.match(bad.message, /format must be one of text, json, mermaid, dot/)
      const nan = yield* Effect.flip(
        graphCommandFrom("query", { ...base, text: "x", hops: "many" }, "/w")
      )
      assert.match(nan.message, /hops must be a positive integer/)
    })
  )
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/shell/test/Cli.test.ts`
Expected: FAIL — `graphCommandFrom` is not exported.

- [ ] **Step 3: Add the verb**

In `packages/shell/src/Cli.ts`, next to `profileCommand`:

```ts
import {
  makeGraphProgram,
  nodeGraphDependencies,
  type GraphCommand,
  type GraphFormat
} from "@llm4ts/runner/Graph"

const graphFormats: ReadonlyArray<GraphFormat> = ["text", "json", "mermaid", "dot"]

interface GraphFlags {
  readonly repo: Option.Option<string>
  readonly pack: Option.Option<string>
  readonly format: string
  readonly kind: Option.Option<string>
  readonly hops: string
  readonly max: string
  readonly all: boolean
  readonly force: boolean
  readonly text?: string
  readonly from?: string
  readonly to?: string
  readonly program?: string
}

const positiveInt = (name: string, raw: string): Effect.Effect<number, ShellUsageError> => {
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new ShellUsageError({ message: `${name} must be a positive integer, got '${raw}'` })
      )
}

export const graphCommandFrom = (
  sub: "build" | "query" | "path" | "closure" | "stats" | "probe",
  flags: GraphFlags,
  cwd: string
): Effect.Effect<GraphCommand, ShellUsageError> =>
  Effect.gen(function* () {
    const repo = resolve(
      cwd,
      Option.getOrElse(flags.repo, () => ".")
    )
    const pack = Option.isSome(flags.pack) ? { pack: flags.pack.value } : {}
    const format = graphFormats.find((candidate) => candidate === flags.format)
    if (format === undefined) {
      return yield* new ShellUsageError({
        message: `format must be one of ${graphFormats.join(", ")}, got '${flags.format}'`
      })
    }
    switch (sub) {
      case "build":
        return { _tag: "build", repo, ...pack }
      case "stats":
        return { _tag: "stats", repo, ...pack, format }
      case "probe":
        return { _tag: "probe", repo, ...pack, format }
      case "query":
        return {
          _tag: "query",
          repo,
          ...pack,
          text: flags.text ?? "",
          ...(Option.isSome(flags.kind) ? { kind: flags.kind.value } : {}),
          hops: yield* positiveInt("hops", flags.hops),
          format,
          all: flags.all,
          force: flags.force
        }
      case "path":
        return {
          _tag: "path",
          repo,
          ...pack,
          from: flags.from ?? "",
          to: flags.to ?? "",
          max: yield* positiveInt("max", flags.max),
          format,
          force: flags.force
        }
      case "closure":
        return {
          _tag: "closure",
          repo,
          ...pack,
          program: flags.program ?? "",
          max: yield* positiveInt("max", flags.max),
          format,
          force: flags.force
        }
    }
  })

const graphFlags = {
  repo: Flag.String("repo").pipe(
    Flag.optional,
    Flag.withDescription("The legacy repository (defaults to the current directory)")
  ),
  pack: Flag.String("pack").pipe(
    Flag.optional,
    Flag.withDescription("Pack name or directory (defaults to LLM4TS_PACK, then cobol-springboot)")
  ),
  format: Flag.String("format").pipe(
    Flag.withDefault("text"),
    Flag.withDescription("text | json | mermaid | dot")
  ),
  kind: Flag.String("kind").pipe(
    Flag.optional,
    Flag.withDescription("Only nodes of this kind (query)")
  ),
  hops: Flag.String("hops").pipe(
    Flag.withDefault("1"),
    Flag.withDescription("Neighbourhood radius (query)")
  ),
  max: Flag.String("max").pipe(
    Flag.withDefault("12"),
    Flag.withDescription("Max hops (path) or files (closure)")
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Render the whole estate instead of the neighbourhood")
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Render mermaid above the 150-node cap")
  )
}

const runGraph = (sub: Parameters<typeof graphCommandFrom>[0], flags: GraphFlags) =>
  Effect.gen(function* () {
    const command = yield* graphCommandFrom(sub, flags, process.cwd())
    yield* Console.log(
      yield* makeGraphProgram(command, nodeGraphDependencies(process.env, shellTierPaths()))
    )
  })

const graphBuildCommand = Command.make("build", graphFlags, (flags) =>
  runGraph("build", flags)
).pipe(
  Command.withDescription(
    "Scan the estate with the pack's rules and write .llm4ts/graph/<pack>.json"
  )
)
const graphQueryCommand = Command.make(
  "query",
  { text: Argument.String("text"), ...graphFlags },
  (flags) => runGraph("query", flags)
).pipe(Command.withDescription("Nodes matching a text and their neighbourhood"))
const graphPathCommand = Command.make(
  "path",
  { from: Argument.String("from"), to: Argument.String("to"), ...graphFlags },
  (flags) => runGraph("path", flags)
).pipe(Command.withDescription("Shortest path between two node references, either direction"))
const graphClosureCommand = Command.make(
  "closure",
  { program: Argument.String("program"), ...graphFlags },
  (flags) => runGraph("closure", flags)
).pipe(Command.withDescription("A program's dependency closure as the analyst sees it"))
const graphStatsCommand = Command.make("stats", graphFlags, (flags) =>
  runGraph("stats", flags)
).pipe(Command.withDescription("Nodes, edges, mechanisms, origins and unresolved items by kind"))
const graphProbeCommand = Command.make("probe", graphFlags, (flags) =>
  runGraph("probe", flags)
).pipe(Command.withDescription("Evaluate the pack's '## Probe:' flows"))

const graphCommand = Command.make("graph", {}, () =>
  Console.log("llm4ts graph <build|query|path|closure|stats|probe> --repo <legacy> [--pack <name>]")
).pipe(
  Command.withDescription("The legacy estate's code graph (ADR 0030): build it, query it, draw it"),
  Command.withSubcommands([
    graphBuildCommand,
    graphQueryCommand,
    graphPathCommand,
    graphClosureCommand,
    graphStatsCommand,
    graphProbeCommand
  ])
)
```

Register `graphCommand` in the `withSubcommands` list after `profileCommand`. If `Command.make`'s config object does not accept spreading `graphFlags` with an `Argument`, list the fields explicitly in each subcommand.

- [ ] **Step 4: Run the tests and a manual smoke**

Run: `pnpm vitest run packages/shell/test/Cli.test.ts`
Expected: PASS.

Then, from the repo root after `pnpm build`:

```bash
node packages/shell/dist/cli-main.js graph --help
```

Expected: the six subcommands listed.

- [ ] **Step 5: Commit**

```bash
git add packages/shell/src/Cli.ts packages/shell/test/Cli.test.ts
git commit -m "shell: llm4ts graph verb"
```

---

### Task 15: Documentation, changelog, verification chain

**Files:**

- Modify: `skills/authoring-llm4ts-packs/SKILL.md`, `skills/authoring-llm4ts-packs/references/manifest.md`, `CHANGELOG.md`, `docs/adr/0030-code-graph.md` (status), `docs/superpowers/specs/2026-10-07-code-graph-design.md` (status)

- [ ] **Step 1: Skill text**

In `SKILL.md` Step 1, replace the `## Coverage:`/`## Survey:` bullet with:

```markdown
- `## Coverage: <name>` and `## Survey: <name>` each carry a `files:` regex
  and a `unit:` regex whose first capture group is the unit name. Coverage
  units must all appear in the traceability matrix; survey units are
  file-to-file edges of the dependency graph.
- `## Node: <kind>` (`files:`, `pattern:` with a `(?<name>…)` group; other
  named groups become attrs; `descriptor: yes` for wiring records such as a
  `web.xml` mapping; `anchor: <attr>` when the node stands for another unit),
  `## Edge: <kind>` (`pattern:` with `(?<to>…)`, optional `(?<thru>…)`,
  `from:`/`to:` node kinds, default `file`) and `## Join: <kind>` (`from:
<kind>.<attr>`, `to: <kind>.<attr>`, `match: exact | url`, `scope: estate
| app | file`) describe sub-file nodes and the links a single regex cannot
  see, such as an ajax URL to the servlet `web.xml` maps it to.
- `## Probe: <name>` (`from:`, `to:` node references) names a flow that must
  be connected end to end. Pack-check fails when a probe is broken: write one
  per flow you know the estate has before you trust the graph.
```

In Step 3, after the paragraph on warnings, add:

```markdown
The check also builds the graph: one line per Node, Edge and Join rule with
counts and samples, the unresolved items by reason (`edge-target`,
`missing-attr`, `join-from`, `join-to`, `isolated`), and one line per probe.
`llm4ts graph query "<text>" --repo <estate>` and `llm4ts graph path <from>
<to> --format mermaid` show what a rule produced; `llm4ts graph probe` reruns
the probes alone.
```

In Rules, replace the first bullet's parenthetical "or single lines (`unit:`)" with "or file contents with flags `gm` (`unit:`, `pattern:`), so `^` anchors a line and `[\s\S]*?` spans lines".

Add a `## Node`, `## Edge`, `## Join`, `## Probe`, `## Graph` entry to `references/manifest.md` in the same format the file uses for `## Survey`.

- [ ] **Step 2: Changelog**

Add at the top of `CHANGELOG.md`:

```markdown
## 2.38.0

The survey graph becomes a code graph (ADR 0030).

- **Sub-file nodes and declarative joins.** Packs declare `## Node:`,
  `## Edge:` and `## Join:` sections beside `## Survey:`; an ajax call or a
  form joins the servlet `web.xml` maps its URL to (servlet-spec matching,
  per web app), COBOL paragraphs and sections carry `PERFORM`, `PERFORM …
THRU` and `GO TO` edges. Every edge records its rule and mechanism.
- **Probes.** `## Probe:` names a flow that must be connected; pack-check
  fails on a broken one, and `llm4ts graph probe` reruns them.
- **Bounded LLM pass.** `modernize-survey` offers the scanner's unresolved
  items to the read-only seat in batches; an answer is kept only when its
  quoted line is found in the file, and may fill an attribute or add an edge
  between existing nodes, never a node.
- **A cache the flows read.** `.llm4ts/graph/<pack>.json`, fresh while file
  hashes and rules match; extract, refine and convert read it, so LLM edges
  reach the analyst's closure instead of being rebuilt away. Specs open with
  the program's closure as a mermaid diagram; the inventory gains cluster
  diagrams and entry paths; `graph.dot` sits beside `graph.json`.
- **`llm4ts graph build | query | path | closure | stats | probe`**, each
  with `--format text|json|mermaid|dot`.
- Shipped packs: `j2ee-nextjs-spa` joins ajax and forms through `web.xml`
  (its `jsp-form-action`/`jsp-ajax-target` cluster kinds are unchanged);
  `cobol-springboot` and `cobol-kafka` gain section and paragraph nodes.
```

- [ ] **Step 3: Status lines**

ADR 0030: `Status: Accepted`. Spec: `Status: implemented in 2.38.0 (ADR 0030)`.

- [ ] **Step 4: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

Expected: all green. Then `pnpm build && node scripts/pack-smoke.mjs`. Expected: the smoke resolves `@llm4ts/flow/GraphCache`, `@llm4ts/flow/GraphQuery`, `@llm4ts/runner/Graph` for an external consumer (add them to the smoke's import list if it enumerates subpaths).

- [ ] **Step 5: Commit (no version bump yet)**

```bash
git add skills/authoring-llm4ts-packs CHANGELOG.md docs/adr/0030-code-graph.md docs/superpowers/specs/2026-10-07-code-graph-design.md
git commit -m "docs: pack graph sections, probes and the graph verb (ADR 0030)"
```

The version bump (`pnpm version:set 2.38.0`, commit, tag) is the user's release step after the bank probes are written and pass; it is not part of this plan's execution.

---

### Task 16: Spine-first closure for the analyst (after measurement)

**Files:**

- Modify: `packages/flow/src/Survey.ts` (`closureFor`), `flows/lib/modernize-extract.ts` (`programAsk`)
- Test: `packages/flow/test/CodeGraph.test.ts`

**Interfaces:**

- Produces: `closureFor(graph, program, maxFiles, options?: { spine?: ReadonlyArray<string> })` where `spine` is a list of edge kinds; files reached through spine kinds (join kinds and probe path kinds) rank before the rest at equal depth. `spineKindsOf(rules: GraphRules): ReadonlyArray<string>` = join kinds plus every edge kind that appears on a passing probe path.

- [ ] **Step 0: Measure first**

Run an extract on a real estate with the graph from Tasks 1–15, then `llm4ts profile --json > before.json`. Only continue if the analyst's prompt sizes or explore turns show the closure order matters (programs whose closure is truncated at `LLM4TS_MAX_CLOSURE_FILES`). Record the numbers in the spec under a "Spine-first measurement" heading. If the closure is never truncated on the estate, stop here and note it.

- [ ] **Step 1: Write the failing test**

```ts
it.effect("closureFor ranks files reached through spine kinds first at equal depth", () =>
  Effect.gen(function* () {
    const { graph } = yield* built
    // fattura reaches header (jsp-include) and InvoiceServlet (jsp-form-action) at depth 1.
    assert.deepStrictEqual(closureFor(graph, "fattura", 1), ["web/header.jsp"])
    assert.deepStrictEqual(closureFor(graph, "fattura", 1, { spine: ["jsp-form-action"] }), [
      "src/com/legacy/InvoiceServlet.java"
    ])
  })
)
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts -t "spine"`
Expected: FAIL — `closureFor` ignores the option.

- [ ] **Step 3: Implement**

In `closureFor`, when `options.spine` is set, order each frontier's `next` so edges whose kind is in `spine` come first (stable), before applying `maxFiles`. In `flows/lib/modernize-extract.ts`, `programAsk` callers pass `{ spine: spineKindsOf(pack.graph) }` where `spineKindsOf` is exported from `GraphRules.ts` as the join kinds (probe path kinds need a graph, so add them in the flow: `[...joinKinds, ...probeResults(graph, pack.graph.probes).flatMap((r) => r.path?.map((e) => e.kind) ?? [])]`). `programAsk` then lists the files past `maxClosureFiles()` as "also on the path, not inlined:" names only, which requires `closureFor` to return at most `maxFiles` as today plus a second call with a larger cap for the names; keep the prompt's "EXACTLY these resolved dependencies" sentence.

- [ ] **Step 4: Run tests, then measure again**

Run: `pnpm vitest run packages/flow/test/CodeGraph.test.ts flows/test` and the same extract with `llm4ts profile --against before.json`. Record the delta in the spec.

- [ ] **Step 5: Commit**

```bash
git add packages/flow/src/Survey.ts packages/flow/src/GraphRules.ts flows/lib/modernize-extract.ts packages/flow/test/CodeGraph.test.ts docs/superpowers/specs/2026-10-07-code-graph-design.md
git commit -m "extract: spine-first closure order for the analyst, measured"
```

---

## Self-review notes

- **Spec coverage.** Schema and helpers (T1), DSL and pack parsing (T2), scanner (T3), joins/app scope/unresolved (T4), cache (T5), worklist (T6), queries and probes (T7), renders (T8), shipped packs (T9), survey flow (T10), extract/refine/convert readers and closure diagram (T11), pack-check (T12), runner program (T13), shell verb (T14), docs/changelog (T15), spine-first closure (T16). `origin: external` / `mechanism: codegraph` are reserved in T1 and consumed by `carryContributions` in T5; no adapter task, per the ADR.
- **Type consistency.** `nodeId`, `nodeKind`, `nodeAttrs`, `nodeLineStart`, `nodeLineEnd`, `edgeOrigin`, `edgeConfidence` are defined in T1 and used unchanged in T3–T8 and T13. `GraphView` is defined in T7 and consumed by T8 and T13. `freshGraph` returns `{ graph, reused, cache }` in T5 and is read that way in T10, T11, T13. `WorklistAnswer` fields are `edges`, `attrs`, `notes` in T6 and in the T10 stub.
- **Review Focus pins.** Two url-patterns in one mapping (T4 last test); `${ctx}` and `*.do` joins (T4 first test); v1 `graph.json` decode and identity projection (T1); off-by-three snippet and literal endpoint dropped (T6); rule hash and evidence-file invalidation (T5).
- **Known behaviour change.** Survey rule patterns now run with `gm`; a `^`-anchored `## Survey:` rule that previously matched only at file start now matches every line. The survey smoke tests filter by kind and pass; `pack-check` samples may grow for such rules.
