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
  nodeKind,
  nodeLabel,
  nodeLineStart,
  type SurveyNode,
  type Unresolved
} from "./Survey.ts"

/**
 * The bounded LLM pass of the code graph (ADR 0030 decision 4). The scanner's
 * `unresolved` list becomes a worklist; the seat may fill an attr of an
 * existing node or add an edge between two existing nodes, each tied to a
 * source line that is checked here before anything is merged. It may not
 * create nodes.
 */
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

/**
 * Up to eight existing nodes worth naming to the seat: lexical matches on the
 * item's reference, name and attrs, and for a join hole every node of the
 * join's target kind (a dynamic URL matches no token of any mapping).
 */
const candidatesFor = (
  graph: SurveyGraph,
  item: Unresolved,
  node: SurveyNode,
  rules: GraphRules | undefined
): ReadonlyArray<WorklistCandidate> => {
  const needles = tokens(
    `${item.reference ?? ""} ${node.name} ${Object.values(nodeAttrs(node)).join(" ")}`
  )
  const targetKinds = new Set(
    item.reason === "missing-attr" || item.reason === "join-from"
      ? (rules?.joins ?? []).filter((rule) => rule.kind === item.rule).map((rule) => rule.toKind)
      : []
  )
  return graph.nodes
    .filter((candidate) => nodeId(candidate) !== nodeId(node))
    .map((candidate) => {
      const hay =
        `${nodeId(candidate)} ${nodeLabel(candidate)} ${Object.values(nodeAttrs(candidate)).join(" ")}`.toLowerCase()
      const lexical = needles.filter((needle) => hay.includes(needle)).length
      return { candidate, score: lexical + (targetKinds.has(nodeKind(candidate)) ? 1 : 0) }
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
  max: number,
  rules?: GraphRules
): ReadonlyArray<WorklistItem> => {
  const degree = (id: string): number => graph.incoming(id).length + graph.outgoing(id).length
  // Rank and cut first; reading context and scoring candidates is paid only
  // for the items actually offered.
  const ranked = graph.unresolved
    .flatMap((item) => {
      const node = graph.node(item.node)
      return node === undefined ? [] : [{ item, node, degree: degree(item.node) }]
    })
    .sort(
      (left, right) => right.degree - left.degree || left.item.node.localeCompare(right.item.node)
    )
    .slice(0, max)
  return ranked.map(({ item, node }) => ({
    unresolved: item,
    node,
    context: numbered(contents(item.file) ?? "", item.line),
    candidates: candidatesFor(graph, item, node, rules)
  }))
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

const describeCandidate = (candidate: WorklistCandidate): string =>
  Object.keys(candidate.attrs).length === 0
    ? candidate.id
    : `${candidate.id} ${JSON.stringify(candidate.attrs)}`

const describeItem = (item: WorklistItem, index: number): string =>
  [
    `### Item ${index + 1}: ${item.unresolved.reason} — rule '${item.unresolved.rule}'`,
    `Node: ${nodeId(item.node)} (line ${nodeLineStart(item.node)} of ${item.node.path})`,
    ...(item.unresolved.reference === undefined
      ? []
      : [`Reference the scanner could not resolve: ${item.unresolved.reference}`]),
    `Candidates (existing nodes with matching tokens): ${
      item.candidates.length === 0 ? "none" : item.candidates.map(describeCandidate).join("; ")
    }`,
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
  properties: {
    file: { type: "string" },
    line: { type: "integer" },
    snippet: { type: "string" }
  },
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
  const nodesById = new Map(graph.nodes.map((node) => [nodeId(node), node]))
  for (const attr of answer.attrs) {
    const what = `${attr.node}.${attr.key} = ${attr.value}`
    const node = nodesById.get(attr.node)
    if (node === undefined) {
      dropped.push({ what, reason: `unknown node: ${attr.node}` })
      continue
    }
    // The seat fills holes; it never overrides what the scanner read.
    if (nodeAttrs(node)[attr.key] !== undefined) {
      dropped.push({ what, reason: `attr '${attr.key}' already set by the scanner` })
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
