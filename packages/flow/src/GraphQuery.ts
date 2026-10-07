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
  unitName,
  type SurveyNode
} from "./Survey.ts"

/**
 * Pure queries over the code graph (ADR 0030 decision 7): what the `llm4ts
 * graph` verb renders today and a seat tool would wrap tomorrow. Nothing here
 * reads a file or calls a model.
 */
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
    if (lower(node.name) === needle) {
      score += 6
    } else if (lower(node.name).includes(needle)) {
      score += 3
    }
    if (lower(nodeLabel(node)).includes(needle)) {
      score += 2
    }
    if (Object.values(nodeAttrs(node)).some((value) => lower(value).includes(needle))) {
      score += 2
    }
    if (lower(nodeId(node)).includes(needle) || lower(node.path).includes(needle)) {
      score += 1
    }
    return { node, score }
  })
  const strongFiles = new Set(base.filter((hit) => hit.score >= 2).map((hit) => hit.node.path))
  return (
    base
      .map((hit) =>
        hit.score === 0 && strongFiles.has(hit.node.path) ? { ...hit, score: 0.5 } : hit
      )
      // A co-located node (score 0.5) rides along an open search; an explicit
      // kind asks for real matches of that kind only.
      .filter((hit) =>
        options.kind === undefined
          ? hit.score > 0
          : hit.score >= 1 && nodeKind(hit.node) === options.kind
      )
      .sort(
        (left, right) =>
          right.score - left.score || nodeId(left.node).localeCompare(nodeId(right.node))
      )
      .slice(0, options.limit ?? 20)
  )
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
  let frontier: ReadonlyArray<string> = ids
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

/**
 * Raw edges + projected file edges + file→sub-node containment: the graph
 * probes and `--projected` paths walk, so a page reaches the servlet its form
 * posts to and the servlet reaches the ESB call inside it.
 */
export const probeGraph = (graph: SurveyGraph): SurveyGraph => {
  const projected = projectToFiles(graph)
  const containment = graph.nodes
    .filter((node) => nodeKind(node) !== "file")
    .map((node) =>
      SurveyEdge.make({
        from: unitName(node.path),
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
  let frontF: ReadonlyArray<string> = [from]
  let frontB: ReadonlyArray<string> = [to]
  const join = (meet: string): ReadonlyArray<SurveyEdge> => {
    const head: Array<SurveyEdge> = []
    for (let edge = forward.get(meet); edge !== undefined; edge = forward.get(edge.from)) {
      head.unshift(edge)
    }
    const tail: Array<SurveyEdge> = []
    for (let edge = backward.get(meet); edge !== undefined; edge = backward.get(edge.to)) {
      tail.push(edge)
    }
    return [...head, ...tail]
  }
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (frontF.length === 0 && frontB.length === 0) {
      break
    }
    if (frontF.length > 0 && (frontF.length <= frontB.length || frontB.length === 0)) {
      const next: Array<string> = []
      for (const id of frontF) {
        for (const edge of walk.outgoing(id)) {
          if (!forward.has(edge.to)) {
            forward.set(edge.to, edge)
            next.push(edge.to)
          }
          if (backward.has(edge.to)) {
            return join(edge.to)
          }
        }
      }
      frontF = next
    } else {
      const next: Array<string> = []
      for (const id of frontB) {
        for (const edge of walk.incoming(id)) {
          if (!backward.has(edge.from)) {
            backward.set(edge.from, edge)
            next.push(edge.from)
          }
          if (forward.has(edge.from)) {
            return join(edge.from)
          }
        }
      }
      frontB = next
    }
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

/** The program and its bounded closure, on the file projection. */
export const closureView = (graph: SurveyGraph, program: string, maxFiles: number): GraphView => {
  const projected = projectToFiles(graph)
  const paths = new Set(closureFor(graph, program, maxFiles))
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

const tally = (keys: ReadonlyArray<string>): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {}
  for (const key of keys) {
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

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

/** Each probe's verdict on the union graph: connected, broken, or an endpoint nothing matches. */
export const probeResults = (
  graph: SurveyGraph,
  probes: ReadonlyArray<ProbeRule>,
  maxHops = 12
): ReadonlyArray<ProbeResult> => {
  const walk = probeGraph(graph)
  return probes.map((probe) => {
    const from = resolveNodeRef(graph, probe.from)
    const to = resolveNodeRef(graph, probe.to)
    if (from === undefined) {
      return { probe, status: "unknown-from" }
    }
    if (to === undefined) {
      return { probe, status: "unknown-to" }
    }
    const path = shortestPath(walk, nodeId(from), nodeId(to), maxHops)
    return path === undefined ? { probe, status: "broken" } : { probe, status: "ok", path }
  })
}
