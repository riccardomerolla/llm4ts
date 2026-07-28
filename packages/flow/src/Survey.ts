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

const unitName = (path: string): string => {
  const base = path.split("/").at(-1) ?? path
  const dot = base.lastIndexOf(".")
  return dot < 0 ? base : base.slice(0, dot)
}

const matches = (regex: string, contents: string): ReadonlyArray<string> => {
  const expression = new RegExp(regex, "g")
  return [...contents.matchAll(expression)].map((match) => match[1] ?? match[0])
}

export const surveyGraph = Effect.fn("@llm4ts/flow/Survey.graph")(function* (
  workspace: WorkspaceShape,
  sources: string,
  units: ReadonlyArray<CoverageRule>,
  edgeRules: ReadonlyArray<CoverageRule>
): Effect.fn.Return<SurveyGraph, WorkspaceError> {
  const sourcePattern = new RegExp(sources)
  const paths = (yield* workspace.discover()).filter((path) => sourcePattern.test(path)).sort()
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
  const edges: Array<SurveyEdge> = []
  for (const rule of edgeRules) {
    const filePattern = new RegExp(rule.files)
    for (const path of paths.filter((path) => filePattern.test(path))) {
      for (const target of new Set(matches(rule.unit, contents.get(path) ?? ""))) {
        const edge = SurveyEdge.make({
          from: unitName(path),
          to: target,
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
