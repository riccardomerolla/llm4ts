import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { CoverageRule } from "./SpecChecks.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

export class SurveyNode extends Schema.Class<SurveyNode>("SurveyNode")({
  path: Schema.String,
  name: Schema.String,
  lines: Schema.Int,
  units: Schema.Int
}) {}

export class SurveyEdge extends Schema.Class<SurveyEdge>("SurveyEdge")({
  from: Schema.String,
  to: Schema.String,
  kind: Schema.String
}) {}

export class SurveyGraph extends Schema.Class<SurveyGraph>("SurveyGraph")({
  nodes: Schema.Array(SurveyNode),
  edges: Schema.Array(SurveyEdge)
}) {
  incoming(name: string): ReadonlyArray<SurveyEdge> {
    return this.edges.filter((edge) => edge.to === name)
  }

  outgoing(name: string): ReadonlyArray<SurveyEdge> {
    return this.edges.filter((edge) => edge.from === name)
  }
}

/**
 * The transitive dependency closure of `program` as repo-relative paths,
 * breadth-first, excluding the program itself. The `seen` set is required, not
 * optional bookkeeping: COBOL copybook graphs genuinely contain cycles (a
 * copybook that COPYs something which eventually COPYs back), and without it
 * this walk would never terminate on a real estate. Truncated to `maxFiles` so
 * a program pulling hundreds of copybooks still gets a bounded, visible subset
 * instead of an unbounded read.
 */
export const closureFor = (
  graph: SurveyGraph,
  program: string,
  maxFiles: number
): ReadonlyArray<string> => {
  const pathOf = new Map(graph.nodes.map((node) => [node.name, node.path]))
  const walk = (
    frontier: ReadonlyArray<string>,
    seen: ReadonlySet<string>,
    acc: ReadonlyArray<string>
  ): ReadonlyArray<string> => {
    if (frontier.length === 0 || acc.length >= maxFiles) {
      return acc.slice(0, maxFiles)
    }
    const next = [
      ...new Set(frontier.flatMap((from) => graph.outgoing(from).map((edge) => edge.to)))
    ].filter((name) => !seen.has(name))
    return walk(next, new Set([...seen, ...next]), [
      ...acc,
      ...next.flatMap((name) => {
        const path = pathOf.get(name)
        return path === undefined ? [] : [path]
      })
    ])
  }
  return walk([program], new Set([program]), [])
}

/**
 * A source file's unit name: its basename without the extension. The graph
 * keys nodes by it, and `resolveUnit` folds edge targets onto it.
 */
export const unitName = (path: string): string => {
  const base = path.split("/").at(-1) ?? path
  const dot = base.lastIndexOf(".")
  return dot < 0 ? base : base.slice(0, dot)
}

/**
 * The unit a captured reference points at. COBOL rules capture the bare unit
 * name (`CALL 'FEECALC'`), but web estates reference units by PATH —
 * `<jsp:include page="header.jsp">`, `page="/WEB-INF/fragments/footer.jsp"`
 * — so a raw capture would never equal a node name, every fragment would show
 * zero incoming edges, and the inventory would flag the most-included files
 * in the estate as retire candidates. Unknown references stay as captured:
 * an edge to a unit the estate does not contain is itself a finding.
 */
export const resolveUnit = (reference: string, known: ReadonlySet<string>): string => {
  if (known.has(reference)) {
    return reference
  }
  const folded = unitName(reference)
  return known.has(folded) ? folded : reference
}

const matches = (regex: string, contents: string): ReadonlyArray<string> => {
  const expression = new RegExp(regex, "g")
  return [...contents.matchAll(expression)].map((match) => match[1] ?? match[0])
}

export interface SurveyGraphOptions {
  /** Regex over repo-relative paths to leave out even when `sources` matches. */
  readonly exclude?: string
}

export const surveyGraph = Effect.fn("@llm4ts/flow/Survey.graph")(function* (
  workspace: WorkspaceShape,
  sources: string,
  units: ReadonlyArray<CoverageRule>,
  edgeRules: ReadonlyArray<CoverageRule>,
  options: SurveyGraphOptions = {}
): Effect.fn.Return<SurveyGraph, WorkspaceError> {
  // The source regex narrows discovery itself, so the workspace's result cap
  // counts candidate units rather than every jar, image, and generated file
  // sharing the tree with them.
  const paths = [
    ...(yield* workspace.discover("**/*", {
      matching: new RegExp(sources),
      ...(options.exclude === undefined ? {} : { excluding: new RegExp(options.exclude) })
    }))
  ].sort()
  const nodes: Array<SurveyNode> = []
  const contents = new Map<string, string>()
  for (const path of paths) {
    const text = yield* workspace.read(path)
    contents.set(path, text)
    nodes.push(
      SurveyNode.make({
        path,
        name: unitName(path),
        lines: text.split(/\r?\n/).length,
        units: units
          .filter((rule) => new RegExp(rule.files).test(path))
          .reduce((count, rule) => count + matches(rule.unit, text).length, 0)
      })
    )
  }
  const known = new Set(nodes.map((node) => node.name))
  const edges: Array<SurveyEdge> = []
  for (const rule of edgeRules) {
    const filePattern = new RegExp(rule.files)
    for (const path of paths.filter((path) => filePattern.test(path))) {
      for (const target of new Set(matches(rule.unit, contents.get(path) ?? ""))) {
        const edge = SurveyEdge.make({
          from: unitName(path),
          to: resolveUnit(target, known),
          kind: rule.name
        })
        if (
          !edges.some(
            (current) =>
              current.from === edge.from && current.to === edge.to && current.kind === edge.kind
          )
        ) {
          edges.push(edge)
        }
      }
    }
  }
  return SurveyGraph.make({ nodes, edges })
})

export const mergeSurveyEdges = (
  graph: SurveyGraph,
  refined: ReadonlyArray<SurveyEdge>
): SurveyGraph => {
  const known = new Set(graph.nodes.map((node) => node.name))
  const existing = new Set(graph.edges.map((edge) => `${edge.from}\u0000${edge.to}`))
  const seen = new Set<string>()
  const kept = refined.flatMap((edge) => {
    const key = `${edge.from}\u0000${edge.to}`
    if (
      edge.from === edge.to ||
      !known.has(edge.from) ||
      !known.has(edge.to) ||
      existing.has(key) ||
      seen.has(key)
    ) {
      return []
    }
    seen.add(key)
    return [
      new SurveyEdge({
        ...edge,
        kind: edge.kind.startsWith("llm-") ? edge.kind : `llm-${edge.kind}`
      })
    ]
  })
  return new SurveyGraph({
    nodes: graph.nodes,
    edges: [...graph.edges, ...kept]
  })
}

export const renderSurveyInventory = (graph: SurveyGraph): string => {
  const rows = [...graph.nodes]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((node) => {
      const incoming = graph.incoming(node.name).length
      const outgoing = graph.outgoing(node.name).length
      const flags = incoming === 0 && outgoing === 0 ? "unreferenced — retire candidate?" : ""
      return `| ${node.name} | ${node.path} | ${node.lines} | ${node.units} | ${incoming} | ${outgoing} | ${flags} |`
    })
  const refined = graph.edges.filter((edge) => edge.kind.startsWith("llm-")).length
  return [
    "# Estate inventory",
    "",
    "| Unit | Path | Lines | Units | In | Out | Flags |",
    "| ---- | ---- | ----- | ----- | -- | --- | ----- |",
    ...rows,
    "",
    `${graph.nodes.length} unit(s), ${graph.edges.length} edge(s).`,
    ...(refined === 0 ? [] : [`${refined} edge(s) came from the LLM graph-refine step.`]),
    ""
  ].join("\n")
}

/** The `graph.json` artifact: the graph as it is read back by later phases. */
export const renderSurveyGraphJson = (graph: SurveyGraph): string =>
  JSON.stringify(graph, undefined, 2)

/**
 * What a pack contributes to the survey's two reasoning prompts. The frame
 * around it — the JSON contracts, the evidence rule, the wave discipline — is
 * stack-neutral and lives here; everything that names a technology comes
 * from the pack: the edge rules its graph was built from, and the optional
 * `prompts/survey-refine.md` / `prompts/survey-triage.md` sidecars describing
 * where THAT stack hides the links regexes miss and how to weigh its units.
 */
export interface SurveyPromptContext {
  /** The pack's `## Survey:` edge rules — the graph's provenance, by name. */
  readonly rules: ReadonlyArray<CoverageRule>
  /** The pack's stack-specific guidance, or undefined for the neutral default. */
  readonly guidance: string | undefined
}

const ruleNames = (context: SurveyPromptContext): string =>
  context.rules.length === 0 ? "none" : context.rules.map((rule) => rule.name).join(", ")

const defaultRefineGuidance = [
  "Regexes miss links the source establishes indirectly: invocations whose target is held",
  "in a variable or configuration entry, wiring declared in descriptors instead of code,",
  "fragments pulled in by inclusion or templating, and units only a build or scheduler",
  "step names."
].join("\n")

const defaultTriageGuidance = [
  "Weigh each unit by what depends on it and what it depends on: shared units many others",
  "reference are migrated early or wrapped; units nothing references are retire candidates",
  "unless an entry point outside the graph (scheduler, external caller, deployment",
  "descriptor) reaches them."
].join("\n")

export const surveyRefinePrompt = (graph: SurveyGraph, context: SurveyPromptContext): string =>
  [
    "You are refining the dependency graph of a legacy estate. The graph below was built",
    "deterministically — one node per source file (named by its file name without the",
    `extension), one edge per regex match of the pack's survey rules (${ruleNames(context)}).`,
    context.guidance ?? defaultRefineGuidance,
    'You have read-only access to the estate — read the sources (each node\'s "path" names its',
    "file) and find the dependency edges the regexes missed. Prioritise the suspicious shapes:",
    "units with fewer outgoing edges than the source suggests, units nothing references, units",
    "with degree 0.",
    "",
    "Produce:",
    '- "edges": ONLY links the graph does not already have, and ONLY between the units listed',
    '  below (use the exact unit names). Each edge: "from" (the referencing unit), "to" (the',
    '  referenced unit), "kind" (how the link is made — a short kebab-case label), and',
    '  "evidence" (file, line, and the statement that establishes the link — no evidence, no',
    "  edge). References to external systems, platform services, or third-party libraries are",
    '  NOT edges; put them in "notes".',
    '- "notes": references you could not resolve to a unit — indirect targets whose value you',
    "  could not trace, external systems. Empty if none.",
    "",
    `Units: ${graph.nodes
      .map((node) => node.name)
      .sort()
      .join(", ")}`,
    "",
    "Graph (JSON):",
    renderSurveyGraphJson(graph)
  ].join("\n")

export const surveyTriagePrompt = (
  graph: SurveyGraph,
  inventory: string,
  context: SurveyPromptContext
): string =>
  [
    "You are triaging a legacy estate for modernization. Below are its inventory and",
    `dependency graph (regex-derived from the source by the pack's survey rules — ${ruleNames(context)} —`,
    "plus `llm-…` edges the graph-refine step grounded in the source with evidence — trust them).",
    context.guidance ?? defaultTriageGuidance,
    "",
    "Produce:",
    '- "triage": for EVERY unit in the inventory, a disposition:',
    '  - "rewrite": actively used business logic or user-facing behaviour to modernize;',
    '  - "retire": unreferenced/dead — candidate for decommissioning, with the evidence;',
    '  - "wrap": keep on the legacy platform and front with an API (shared units other',
    "    estates still call, or units out of this modernization's scope).",
    "  Rationale in one sentence, grounded in the graph (degrees, callers, size).",
    '- "waves": dependency-coherent migration slices for the REWRITE units: a wave\'s units',
    "  should depend only on already-migrated or same-wave units where possible; leaves and",
    "  low-fan-in units first; name each wave (wave-1, wave-2, …) and give the ordering rationale.",
    '- "notes": anything the graph could not resolve — indirect references, cycles worth a',
    "  human look. Empty if none.",
    "",
    "Inventory:",
    inventory,
    "",
    "Graph (JSON):",
    renderSurveyGraphJson(graph)
  ].join("\n")
