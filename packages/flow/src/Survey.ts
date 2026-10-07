import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PlanParseError } from "./FlowError.ts"
import {
  edgeRuleOfSurvey,
  emptyGraphRules,
  matchUrl,
  normalizeUrl,
  type EdgeRule,
  type GraphRules,
  type JoinRule,
  type NodeRule
} from "./GraphRules.ts"
import type { CoverageRule } from "./SpecChecks.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

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

/**
 * A node of the estate graph. The four original fields describe a FILE node;
 * the ADR 0030 fields are optional on the wire so a pre-0030 `graph.json`
 * decodes and the four-field constructor keeps compiling — read them through
 * `nodeId`, `nodeKind` and the other helpers below, never directly.
 */
export class SurveyNode extends Schema.Class<SurveyNode>("SurveyNode")({
  path: Schema.String,
  name: Schema.String,
  lines: Schema.Int,
  units: Schema.Int,
  id: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  lineStart: Schema.optionalKey(Schema.Int),
  lineEnd: Schema.optionalKey(Schema.Int),
  attrs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  origin: Schema.optionalKey(GraphOrigin),
  /** A wiring record (a `web.xml` mapping), not a unit: contracted by the file projection. */
  descriptor: Schema.optionalKey(Schema.Boolean),
  /** The attr naming the unit this node stands for (a declaration's class). */
  anchor: Schema.optionalKey(Schema.String)
}) {}

export class SurveyEdge extends Schema.Class<SurveyEdge>("SurveyEdge")({
  from: Schema.String,
  to: Schema.String,
  kind: Schema.String,
  origin: Schema.optionalKey(GraphOrigin),
  confidence: Schema.optionalKey(GraphConfidence),
  /** The pack section that produced the edge. */
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

/** An attr the LLM pass filled on an existing node, with the line that justifies it. */
export class Fill extends Schema.Class<Fill>("Fill")({
  node: Schema.String,
  key: Schema.String,
  value: Schema.String,
  evidence: GraphEvidence
}) {}

export class SurveyGraph extends Schema.Class<SurveyGraph>("SurveyGraph")({
  nodes: Schema.Array(SurveyNode),
  edges: Schema.Array(SurveyEdge),
  unresolved: Schema.Array(Unresolved).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([]))
  ),
  fills: Schema.Array(Fill).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([]))
  )
}) {
  incoming(id: string): ReadonlyArray<SurveyEdge> {
    return indexOf(this).incoming.get(id) ?? []
  }

  outgoing(id: string): ReadonlyArray<SurveyEdge> {
    return indexOf(this).outgoing.get(id) ?? []
  }

  node(id: string): SurveyNode | undefined {
    return indexOf(this).byId.get(id)
  }
}

interface GraphIndex {
  readonly byId: ReadonlyMap<string, SurveyNode>
  readonly incoming: ReadonlyMap<string, ReadonlyArray<SurveyEdge>>
  readonly outgoing: ReadonlyMap<string, ReadonlyArray<SurveyEdge>>
}

/**
 * Adjacency, built once per graph instance and kept in a WeakMap: a graph is
 * immutable (every change constructs a new one), so the index never goes
 * stale, and walks over an estate-sized graph stay linear instead of V × E.
 */
const indexes = new WeakMap<SurveyGraph, GraphIndex>()

const indexOf = (graph: SurveyGraph): GraphIndex => {
  const cached = indexes.get(graph)
  if (cached !== undefined) {
    return cached
  }
  const byId = new Map<string, SurveyNode>()
  for (const node of graph.nodes) {
    const id = nodeId(node)
    if (!byId.has(id)) {
      byId.set(id, node)
    }
  }
  const incoming = new Map<string, Array<SurveyEdge>>()
  const outgoing = new Map<string, Array<SurveyEdge>>()
  for (const edge of graph.edges) {
    const into = incoming.get(edge.to)
    if (into === undefined) {
      incoming.set(edge.to, [edge])
    } else {
      into.push(edge)
    }
    const from = outgoing.get(edge.from)
    if (from === undefined) {
      outgoing.set(edge.from, [edge])
    } else {
      from.push(edge)
    }
  }
  const index: GraphIndex = { byId, incoming, outgoing }
  indexes.set(graph, index)
  return index
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

const inferred: GraphConfidence = "inferred"

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
  const edgeKey = (edge: SurveyEdge): string =>
    `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edgeConfidence(edge)}`
  let edges: ReadonlyArray<SurveyEdge> = graph.edges
  for (let round = 0; round <= graph.nodes.length; round += 1) {
    if (!edges.some((edge) => contractible.has(edge.to))) {
      break
    }
    const next: Array<SurveyEdge> = []
    const keys = new Set<string>()
    const push = (edge: SurveyEdge): void => {
      const key = edgeKey(edge)
      if (!keys.has(key)) {
        keys.add(key)
        next.push(edge)
      }
    }
    for (const edge of edges) {
      if (!contractible.has(edge.to)) {
        push(edge)
        continue
      }
      for (const hop of graph.outgoing(edge.to)) {
        push(
          new SurveyEdge({
            ...edge,
            to: hop.to,
            mechanism: "contraction",
            ...(edgeConfidence(edge) === "inferred" || edgeConfidence(hop) === "inferred"
              ? { confidence: inferred }
              : {})
          })
        )
      }
    }
    // A descriptor cycle re-derives the same edges forever: stop when a round
    // adds nothing new; what still ends on a descriptor is cycle residue.
    if (
      next.length === edges.length &&
      next.every((edge, index) => edgeKey(edge) === edgeKey(edges[index]!))
    ) {
      break
    }
    edges = next
  }
  const seen = new Set<string>()
  const projected = edges.flatMap((edge) => {
    if (contractible.has(edge.from) || contractible.has(edge.to)) {
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
    try: (): unknown => JSON.parse(text),
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
  const projected = projectToFiles(graph)
  const pathOf = new Map(projected.nodes.map((node) => [node.name, node.path]))
  const walk = (
    frontier: ReadonlyArray<string>,
    seen: ReadonlySet<string>,
    acc: ReadonlyArray<string>
  ): ReadonlyArray<string> => {
    if (frontier.length === 0 || acc.length >= maxFiles) {
      return acc.slice(0, maxFiles)
    }
    const next = [
      ...new Set(frontier.flatMap((from) => projected.outgoing(from).map((edge) => edge.to)))
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

export interface SurveyGraphOptions {
  /** Regex over repo-relative paths to leave out even when `sources` matches. */
  readonly exclude?: string
}

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

interface Capture {
  readonly line: number
  readonly groups: Readonly<Record<string, string>>
  /** The first positional group, else the whole match: what a `## Survey:` rule targets. */
  readonly first: string
}

/** Every match of `pattern` (flags `gm`) with its line and defined named groups. */
const captures = (
  pattern: string,
  text: string,
  locate: (offset: number) => number
): ReadonlyArray<Capture> =>
  [...text.matchAll(new RegExp(pattern, "gm"))].map((match) => ({
    line: locate(match.index ?? 0),
    groups: Object.fromEntries(
      Object.entries(match.groups ?? {}).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]]
      )
    ),
    first: match[1] ?? match[0]
  }))

const scanner: GraphOrigin = "scanner"
const exact: GraphConfidence = "exact"

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
    const locate = lineLocator(text)
    nodes.push(
      SurveyNode.make({
        path,
        name: unitName(path),
        lines,
        units: units
          .filter((rule) => new RegExp(rule.files).test(path))
          .reduce((count, rule) => count + captures(rule.unit, text, locate).length, 0),
        id: unitName(path),
        kind: "file",
        lineStart: 1,
        lineEnd: lines
      })
    )
    for (const rule of rules.filter((rule) => new RegExp(rule.files).test(path))) {
      const seen = new Map<string, number>()
      const own: Array<SurveyNode> = []
      for (const hit of captures(rule.pattern, text, locate)) {
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
            origin: scanner,
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

/** Lookups the edge pass needs per capture, built once per scan instead of scanning every node. */
interface NodeLookup {
  /** path → kind → nodes of that kind in the file, in line order. */
  readonly inFile: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<SurveyNode>>>
  /** `kind\0name` → first node anywhere. */
  readonly byKindName: ReadonlyMap<string, SurveyNode>
  /** `path\0kind\0name` → node. */
  readonly byPathKindName: ReadonlyMap<string, SurveyNode>
  readonly known: ReadonlySet<string>
}

const lookupOf = (nodes: ReadonlyArray<SurveyNode>): NodeLookup => {
  const inFile = new Map<string, Map<string, Array<SurveyNode>>>()
  const byKindName = new Map<string, SurveyNode>()
  const byPathKindName = new Map<string, SurveyNode>()
  const known = new Set<string>()
  for (const node of nodes) {
    const kind = nodeKind(node)
    if (kind === "file") {
      known.add(node.name)
    }
    const kinds = inFile.get(node.path) ?? new Map<string, Array<SurveyNode>>()
    const list = kinds.get(kind) ?? []
    list.push(node)
    kinds.set(kind, list)
    inFile.set(node.path, kinds)
    const kindKey = `${kind}\u0000${node.name}`
    if (!byKindName.has(kindKey)) {
      byKindName.set(kindKey, node)
    }
    const pathKey = `${node.path}\u0000${kind}\u0000${node.name}`
    if (!byPathKindName.has(pathKey)) {
      byPathKindName.set(pathKey, node)
    }
  }
  for (const kinds of inFile.values()) {
    for (const list of kinds.values()) {
      list.sort((left, right) => nodeLineStart(left) - nodeLineStart(right))
    }
  }
  return { inFile, byKindName, byPathKindName, known }
}

/** The last node of `kind` in `path` starting at or before `line` (binary search over the file's list). */
const enclosing = (
  lookup: NodeLookup,
  path: string,
  kind: string,
  line: number
): SurveyNode | undefined => {
  const list = lookup.inFile.get(path)?.get(kind) ?? []
  let low = 0
  let high = list.length - 1
  let found: SurveyNode | undefined
  while (low <= high) {
    const mid = (low + high) >> 1
    const candidate = list[mid]!
    if (nodeLineStart(candidate) <= line) {
      found = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

const resolveTarget = (
  lookup: NodeLookup,
  path: string,
  kind: string,
  reference: string
): { readonly id: string; readonly found: boolean } => {
  if (kind === "file") {
    const unit = resolveUnit(reference, lookup.known)
    return { id: unit, found: lookup.known.has(unit) }
  }
  const node =
    lookup.byPathKindName.get(`${path}\u0000${kind}\u0000${reference}`) ??
    lookup.byKindName.get(`${kind}\u0000${reference}`)
  return node === undefined ? { id: reference, found: false } : { id: nodeId(node), found: true }
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
  const lookup = lookupOf(nodes)
  const lineOf = new Map(nodes.map((node) => [nodeId(node), nodeLineStart(node)]))
  const edges: Array<SurveyEdge> = []
  const unresolved: Array<Unresolved> = []
  const seen = new Set<string>()
  const push = (edge: SurveyEdge): void => {
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
      const lines = text.split(/\r?\n/)
      for (const hit of captures(rule.pattern, text, locate)) {
        const reference = rule.positional === true ? hit.first : hit.groups.to
        if (reference === undefined) {
          continue
        }
        const fromNode =
          rule.fromKind === "file" ? undefined : enclosing(lookup, path, rule.fromKind, hit.line)
        const from = fromNode === undefined ? unitName(path) : nodeId(fromNode)
        const evidence = GraphEvidence.make({
          file: path,
          line: hit.line,
          snippet: (lines[hit.line - 1] ?? "").trim()
        })
        const target = resolveTarget(lookup, path, rule.toKind, reference)
        const targets: Array<string> = []
        if (target.found && hit.groups.thru !== undefined && rule.toKind !== "file") {
          const end = resolveTarget(lookup, path, rule.toKind, hit.groups.thru)
          const startLine = lineOf.get(target.id) ?? 0
          const endLine = end.found ? (lineOf.get(end.id) ?? startLine) : startLine
          targets.push(
            ...(lookup.inFile.get(path)?.get(rule.toKind) ?? [])
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
              origin: scanner,
              confidence: exact,
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
    .sort((left, right) => right.length - left.length)[0] ?? ""

const withFills = (
  nodes: ReadonlyArray<SurveyNode>,
  fills: ReadonlyArray<Fill>
): ReadonlyArray<SurveyNode> =>
  nodes.map((node) => {
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

const joinRank: Readonly<Record<JoinMatch, number>> = { exact: 0, prefix: 1, extension: 2 }

/** A join attr: a named group copied into attrs, or the node's own name for `name`. */
const attrOf = (node: SurveyNode, attr: string): string | undefined =>
  attr === "name" ? node.name : nodeAttrs(node)[attr]
const llm: GraphOrigin = "llm"

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
    for (const source of sources) {
      const raw = attrOf(source, rule.fromAttr)
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
        const value = attrOf(target, rule.toAttr)
        if (value === undefined) {
          return []
        }
        const how: JoinMatch | undefined =
          rule.match === "url"
            ? matchUrl(request, value)
            : value.trim() === request
              ? "exact"
              : undefined
        return how === undefined ? [] : [{ target, how, value }]
      })
      // Servlet-spec order: exact beats the longest prefix beats an extension.
      const best = matched.sort(
        (left, right) =>
          joinRank[left.how] - joinRank[right.how] || right.value.length - left.value.length
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
        edges.push(
          SurveyEdge.make({
            from: nodeId(source),
            to: nodeId(best.target),
            kind: rule.kind,
            origin: inferred ? llm : scanner,
            confidence: inferred ? "inferred" : exact,
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
  }
  // A join target nothing reaches, reported once per node whatever the kind:
  // a mapping hit by a form but by no ajax call is wired, not a hole.
  const reached = new Set(edges.map((edge) => edge.to))
  const reportedKinds = new Set<string>()
  for (const rule of rules) {
    if (reportedKinds.has(rule.toKind)) {
      continue
    }
    reportedKinds.add(rule.toKind)
    for (const target of nodes.filter((node) => nodeKind(node) === rule.toKind)) {
      if (!reached.has(nodeId(target))) {
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
  const nodes = withFills(graph.nodes, fills)
  const kept = graph.edges.filter((edge) => !(edge.mechanism ?? "").startsWith("join:"))
  const joined = joinEdges(nodes, fills, rules.joins, appRoots(paths))
  const edges = [...kept, ...joined.edges]
  const projected = projectToFiles(SurveyGraph.make({ nodes, edges, unresolved: [], fills }))
  // A file that only holds wiring records (web.xml) is a descriptor file, not
  // a unit nothing references: it never counts as isolated.
  const wiringFiles = new Set(nodes.filter(isDescriptor).map((node) => node.path))
  const isolated = projected.nodes
    .filter(
      (node) =>
        !wiringFiles.has(node.path) &&
        projected.incoming(node.name).length === 0 &&
        projected.outgoing(node.name).length === 0
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
  // An edge-target hole retires once a non-scanner edge leaves the same node
  // from the same line: the seat (or an external index) answered it.
  const answered = new Set(
    edges
      .filter((edge) => edgeOrigin(edge) !== "scanner" && edge.evidence !== undefined)
      .map((edge) => `${edge.from}\u0000${edge.evidence?.file}\u0000${edge.evidence?.line}`)
  )
  return SurveyGraph.make({
    nodes,
    edges,
    unresolved: [
      ...graph.unresolved.filter(
        (item) =>
          item.reason === "edge-target" &&
          !answered.has(`${item.node}\u0000${item.file}\u0000${item.line}`)
      ),
      ...joined.unresolved,
      ...isolated
    ],
    fills
  })
}

export const buildCodeGraph = Effect.fn("@llm4ts/flow/Survey.buildCodeGraph")(function* (
  workspace: WorkspaceShape,
  options: CodeGraphOptions
): Effect.fn.Return<CodeGraphBuild, WorkspaceError> {
  // The source regex narrows discovery itself, so the workspace's result cap
  // counts candidate units rather than every jar, image, and generated file
  // sharing the tree with them.
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

/** The pre-ADR-0030 entry: Survey rules only, file nodes only. Delegates to `buildCodeGraph`. */
export const surveyGraph = Effect.fn("@llm4ts/flow/Survey.graph")(function* (
  workspace: WorkspaceShape,
  sources: string,
  units: ReadonlyArray<CoverageRule>,
  edgeRules: ReadonlyArray<CoverageRule>,
  options: SurveyGraphOptions = {}
): Effect.fn.Return<SurveyGraph, WorkspaceError> {
  const build = yield* buildCodeGraph(workspace, {
    sources,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    coverage: units,
    rules: { ...emptyGraphRules, edges: edgeRules.map(edgeRuleOfSurvey) }
  })
  return build.graph
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

export const renderSurveyInventory = (full: SurveyGraph): string => {
  // The inventory is a table of UNITS (files); sub-file nodes and descriptors
  // fold onto their files first (ADR 0030).
  const graph = projectToFiles(full)
  const rows = [...graph.nodes]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((node) => {
      const incoming = graph.incoming(node.name).length
      const outgoing = graph.outgoing(node.name).length
      const flags = incoming === 0 && outgoing === 0 ? "unreferenced — retire candidate?" : ""
      return `| ${node.name} | ${node.path} | ${node.lines} | ${node.units} | ${incoming} | ${outgoing} | ${flags} |`
    })
  const refined = full.edges.filter(
    (edge) => edge.kind.startsWith("llm-") || edgeOrigin(edge) === "llm"
  ).length
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
    `Units: ${projectToFiles(graph)
      .nodes.map((node) => node.name)
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
