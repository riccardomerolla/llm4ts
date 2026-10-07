import { clusterPrograms, type ConsolidateRules } from "./Domains.ts"
import { neighborhood, type GraphView } from "./GraphQuery.ts"
import {
  edgeConfidence,
  nodeId,
  nodeKind,
  nodeLabel,
  projectToFiles,
  type SurveyGraph,
  type SurveyNode
} from "./Survey.ts"

/**
 * Renders of a graph view (ADR 0030 decision 7): one view model, three
 * emitters. Nodes group by file, edges carry their kind, inferred edges are
 * dotted, unresolved nodes are red, and every node line ends with its id so a
 * reader can paste it into `llm4ts graph path`.
 */
export const mermaidNodeCap = 150

interface KindStyle {
  readonly mermaid: string
  readonly shape: string
}

/** Reserved kinds get a fixed look; any pack-defined kind falls back to `neutral`. */
const styles: Readonly<Record<string, KindStyle>> = {
  file: { mermaid: "fill:#eef,stroke:#446,color:#000", shape: "box" },
  page: { mermaid: "fill:#efe,stroke:#464,color:#000", shape: "note" },
  "ajax-call": { mermaid: "fill:#ffe,stroke:#664,color:#000", shape: "ellipse" },
  form: { mermaid: "fill:#ffe,stroke:#664,color:#000", shape: "ellipse" },
  "servlet-mapping": { mermaid: "fill:#fee,stroke:#644,color:#000", shape: "hexagon" },
  "servlet-decl": { mermaid: "fill:#fee,stroke:#644,color:#000", shape: "hexagon" },
  "esb-call": { mermaid: "fill:#fdf,stroke:#646,color:#000", shape: "component" },
  "cobol-section": { mermaid: "fill:#eff,stroke:#466,color:#000", shape: "folder" },
  "cobol-paragraph": { mermaid: "fill:#eff,stroke:#466,color:#000", shape: "box" }
}

const neutral: KindStyle = { mermaid: "fill:#f4f4f4,stroke:#888,color:#000", shape: "box" }

const styleOf = (kind: string): KindStyle => styles[kind] ?? neutral

const escapeMermaid = (text: string): string =>
  text.replaceAll('"', "'").replaceAll("$", "＄").replaceAll("{", "(").replaceAll("}", ")")

const escapeDot = (text: string): string => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

/** Mermaid class names may not contain `:` or `/`; kinds are kebab-case already. */
const mermaidClass = (kind: string): string => kind.replace(/[^A-Za-z0-9_-]/g, "_")

const unresolvedIds = (graph: SurveyGraph): ReadonlySet<string> =>
  new Set(graph.unresolved.map((item) => item.node))

const groupedByFile = (
  view: GraphView
): ReadonlyArray<readonly [string, ReadonlyArray<SurveyNode>]> => {
  const groups = new Map<string, Array<SurveyNode>>()
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
      const cls = flagged.has(id) ? ":::unresolved" : `:::${mermaidClass(nodeKind(node))}`
      lines.push(`    ${ids.get(id)}["${escapeMermaid(nodeLabel(node))}"]${cls} %% ${id}`)
    }
    lines.push("  end")
  })
  for (const edge of view.edges) {
    const arrow = edgeConfidence(edge) === "inferred" ? "-.->" : "-->"
    lines.push(`  ${ids.get(edge.from)} ${arrow}|${escapeMermaid(edge.kind)}| ${ids.get(edge.to)}`)
  }
  for (const kind of kinds) {
    lines.push(`  classDef ${mermaidClass(kind)} ${styleOf(kind).mermaid};`)
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
    if (lines.length >= maxLines) {
      return
    }
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
  for (const entry of entries) {
    walk(entry.name, entry.name, new Set([entry.name]), 0)
  }
  return [
    "## Entry paths",
    "",
    ...(lines.length === 0 ? ["(none)"] : lines.map((line) => `- ${line}`)),
    ...(lines.length >= maxLines ? [`- … truncated at ${maxLines} lines`] : []),
    ""
  ].join("\n")
}

/** One mermaid block per multi-program consolidate cluster, on the file projection. */
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
