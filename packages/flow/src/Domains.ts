import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import {
  OpenPoint,
  makeOpenPointsCollector,
  parseApprovalMarker,
  renderOpenPoints
} from "./Decisions.ts"
import { DecisionsInvalid } from "./FlowError.ts"
import { stableHash } from "./Plan.ts"
import type { SurveyGraph } from "./Survey.ts"

export { DecisionsInvalid } from "./FlowError.ts"

/**
 * The grouping overlay of a modernization spec pack (ADR 0015): extraction is
 * per program, delivery is per DOMAIN FEATURE — the pages that share a form
 * target, the steps of one wizard, the shell of included fragments. Seeded
 * deterministically from the survey graph by the pack's `## Consolidate`
 * rules, named and adjusted by the model, approved by a human, and the input
 * `plan.md` is regenerated from.
 */

// ---- Deterministic clustering ------------------------------------------------

export interface ConsolidateRules {
  /** Survey edge kinds that put two units in the same feature. `llm-*` matches by prefix. */
  readonly cluster: ReadonlyArray<string>
  /** Edge kinds whose target attaches as shared context (a fragment) and never clusters. */
  readonly context: ReadonlyArray<string>
}

export interface Cluster {
  readonly programs: ReadonlyArray<string>
  /** Fragments the cluster's programs include, transitively. */
  readonly context: ReadonlyArray<string>
  /** A cluster of fragments themselves: the shell everything includes. */
  readonly shell: boolean
}

const kindMatches = (kind: string, patterns: ReadonlyArray<string>): boolean =>
  patterns.some((pattern) =>
    pattern.endsWith("*") ? kind.startsWith(pattern.slice(0, -1)) : kind === pattern
  )

class UnionFind {
  private readonly parent = new Map<string, string>()

  find(name: string): string {
    const parent = this.parent.get(name)
    if (parent === undefined || parent === name) {
      this.parent.set(name, name)
      return name
    }
    const root = this.find(parent)
    this.parent.set(name, root)
    return root
  }

  union(left: string, right: string): void {
    const a = this.find(left)
    const b = this.find(right)
    if (a !== b) {
      this.parent.set(a < b ? b : a, a < b ? a : b)
    }
  }
}

const byFirst = (left: Cluster, right: Cluster): number =>
  (left.programs[0] ?? "").localeCompare(right.programs[0] ?? "")

/**
 * Programs grouped by the pack's cluster edges: two units joined by an edge of
 * a `cluster:` kind land in one feature, through any intermediate unit (a
 * shared form target, a servlet). Programs that are the target of a
 * `context:` edge are fragments: their own edges never merge anything, they
 * attach to the clusters that include them, and they form shell clusters
 * among themselves. Shell clusters first, then by first program name.
 */
export const clusterPrograms = (
  graph: SurveyGraph,
  programs: ReadonlyArray<string>,
  rules: ConsolidateRules
): ReadonlyArray<Cluster> => {
  const programSet = new Set(programs)
  const contextEdges = graph.edges.filter((edge) => kindMatches(edge.kind, rules.context))
  const fragments = new Set(
    contextEdges.map((edge) => edge.to).filter((name) => programSet.has(name))
  )
  const pages = new UnionFind()
  for (const program of programs) {
    pages.find(program)
  }
  for (const edge of graph.edges) {
    if (
      kindMatches(edge.kind, rules.cluster) &&
      !fragments.has(edge.from) &&
      !fragments.has(edge.to)
    ) {
      pages.union(edge.from, edge.to)
    }
  }
  const shell = new UnionFind()
  for (const fragment of fragments) {
    shell.find(fragment)
  }
  for (const edge of contextEdges) {
    if (fragments.has(edge.from) && fragments.has(edge.to)) {
      shell.union(edge.from, edge.to)
    }
  }
  const includes = new Map<string, Array<string>>()
  for (const edge of contextEdges) {
    if (fragments.has(edge.to)) {
      includes.set(edge.from, [...(includes.get(edge.from) ?? []), edge.to])
    }
  }
  const contextOf = (members: ReadonlyArray<string>): ReadonlyArray<string> => {
    const seen = new Set<string>()
    const frontier = [...members]
    while (frontier.length > 0) {
      const current = frontier.pop()
      if (current === undefined) {
        break
      }
      for (const included of includes.get(current) ?? []) {
        if (!seen.has(included)) {
          seen.add(included)
          frontier.push(included)
        }
      }
    }
    return [...seen].sort()
  }
  const groups = new Map<string, Array<string>>()
  for (const program of programs) {
    if (fragments.has(program)) {
      continue
    }
    const root = pages.find(program)
    groups.set(root, [...(groups.get(root) ?? []), program])
  }
  const shells = new Map<string, Array<string>>()
  for (const fragment of fragments) {
    const root = shell.find(fragment)
    shells.set(root, [...(shells.get(root) ?? []), fragment])
  }
  const shellClusters: Array<Cluster> = [...shells.values()]
    .map((members) => ({ programs: [...members].sort(), context: [], shell: true }))
    .sort(byFirst)
  const pageClusters: Array<Cluster> = [...groups.values()]
    .map((members) => {
      const sorted = [...members].sort()
      return { programs: sorted, context: contextOf(sorted), shell: false }
    })
    .sort(byFirst)
  return [...shellClusters, ...pageClusters]
}

// ---- The map ------------------------------------------------------------------

export class ScenarioRef extends Schema.Class<ScenarioRef>("ScenarioRef")({
  program: Schema.String,
  title: Schema.String
}) {}

export class FeatureScenario extends Schema.Class<FeatureScenario>("FeatureScenario")({
  program: Schema.String,
  title: Schema.String,
  /** Scenarios of other programs this one absorbs as the same behaviour. */
  mergedFrom: Schema.Array(ScenarioRef)
}) {}

export class DomainFeature extends Schema.Class<DomainFeature>("DomainFeature")({
  /** kebab-case, the branch and contract name downstream. */
  id: Schema.String,
  name: Schema.String,
  programs: Schema.Array(Schema.String),
  context: Schema.Array(Schema.String),
  scenarios: Schema.Array(FeatureScenario),
  evidence: Schema.String
}) {}

export class Domains extends Schema.Class<Domains>("Domains")({
  features: Schema.Array(DomainFeature),
  /** Hash of the specs and decisions the map was built from — staleness check. */
  inputsHash: Schema.String,
  openPoints: Schema.Array(OpenPoint),
  approved: Schema.Boolean
}) {
  get unansweredOpenPoints(): ReadonlyArray<OpenPoint> {
    return this.openPoints.filter((point) => point.answer === undefined)
  }

  featureOf(program: string): DomainFeature | undefined {
    return this.features.find((feature) => feature.programs.includes(program))
  }
}

const scenarioKey = (program: string, title: string): string => `${program} / ${title}`

/**
 * Every surviving scenario of the pack must be assigned to exactly one
 * feature, directly or as a `mergedFrom` source; a feature may not claim a
 * scenario the pack does not have. Deterministic, run before any human looks.
 */
export const checkExactlyOnce = (
  domains: Domains,
  surviving: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const assigned = new Map<string, Array<string>>()
  const known = (program: string, title: string): boolean =>
    surviving.get(program)?.has(title) ?? false
  for (const feature of domains.features) {
    for (const scenario of feature.scenarios) {
      const refs = [{ program: scenario.program, title: scenario.title }, ...scenario.mergedFrom]
      for (const ref of refs) {
        const key = scenarioKey(ref.program, ref.title)
        const owners = assigned.get(key) ?? []
        owners.push(feature.id)
        assigned.set(key, owners)
        if (owners.length === 2) {
          violations.push(`scenario '${key}' is assigned twice (${owners.join(", ")})`)
        } else if (owners.length === 1 && !known(ref.program, ref.title)) {
          violations.push(
            `scenario '${key}' in feature ${feature.id} is not a surviving scenario of the pack`
          )
        }
      }
    }
  }
  for (const [program, titles] of surviving) {
    for (const title of titles) {
      if (!assigned.has(scenarioKey(program, title))) {
        violations.push(`scenario '${scenarioKey(program, title)}' is assigned to no feature`)
      }
    }
  }
  return violations
}

// ---- Guide, render, parse ------------------------------------------------------

export const domainsGuide = [
  "## How to read this map",
  "",
  "Each `## Feature:` groups the programs that deliver one domain feature, the",
  "fragments they include as `context:`, and every surviving scenario it absorbs,",
  "one per line as `- <program> / <scenario title>`. A scenario that describes",
  "the same behaviour as another page's is listed once with `(merged from: …)`.",
  "Every surviving scenario of the pack appears exactly once across the map.",
  "The clusters were seeded from the survey graph by the pack's `## Consolidate`",
  "rules; the model named them and proposed merges and folds, each with",
  "`evidence:`. Edit freely: move a scenario line, rename a feature, split or",
  "join sections. Answer `## Open points` with an indented `answer: …` line and",
  "rerun; flip the marker at the end to approve. `inputs:` is the hash of the",
  "specs and decisions this map was built from — the flow regroups when it",
  "changes, or on request.",
  ""
].join("\n")

export const renderDomains = (domains: Domains): string => {
  const blocks = domains.features.map((feature) =>
    [
      `## Feature: ${feature.name} (${feature.id})`,
      "",
      `programs: ${feature.programs.join(", ")}`,
      `context: ${feature.context.join(", ")}`,
      `evidence: ${feature.evidence}`,
      "",
      ...feature.scenarios.map((scenario) => {
        const merged =
          scenario.mergedFrom.length === 0
            ? ""
            : ` (merged from: ${scenario.mergedFrom
                .map((ref) => scenarioKey(ref.program, ref.title))
                .join("; ")})`
        return `- ${scenarioKey(scenario.program, scenario.title)}${merged}`
      }),
      ""
    ].join("\n")
  )
  return [
    "# Domain features",
    "",
    domainsGuide,
    `inputs: ${domains.inputsHash}`,
    "",
    ...blocks,
    "## Open points",
    "",
    ...renderOpenPoints(domains.openPoints),
    ...(domains.openPoints.length === 0 ? [] : [""]),
    domains.approved ? "- [x] Approved" : "- [ ] Approved",
    ""
  ].join("\n")
}

const featureHeading = /^## Feature: (.+?) \(([a-z0-9][a-z0-9-]*)\)\s*$/
const scenarioLine = /^- (.+?) \/ (.+?)(?: \(merged from: (.+)\))?$/

interface FeatureDraft {
  id: string
  name: string
  programs: Array<string>
  context: Array<string>
  scenarios: Array<FeatureScenario>
  evidence: string
}

const list = (value: string): Array<string> =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

export const parseDomains = Effect.fn("@llm4ts/flow/Domains.parse")(function* (
  markdown: string,
  path?: string
): Effect.fn.Return<Domains, DecisionsInvalid> {
  const features: Array<DomainFeature> = []
  const violations: Array<string> = []
  const points = makeOpenPointsCollector()
  let inputsHash = ""
  let approved = false
  let draft: FeatureDraft | undefined
  let section: "feature" | "open" | "other" = "other"
  let fenced = false
  const close = (): void => {
    if (draft === undefined) {
      return
    }
    if (draft.programs.length === 0) {
      violations.push(`feature '${draft.id}' lists no programs`)
    }
    features.push(DomainFeature.make(draft))
    draft = undefined
  }
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const trimmed = (lines[index] ?? "").trim()
    if (trimmed.startsWith("```")) {
      fenced = !fenced
      continue
    }
    if (fenced || trimmed.length === 0 || trimmed.startsWith("# ")) {
      continue
    }
    const marker = parseApprovalMarker(trimmed)
    if (marker !== undefined) {
      approved = marker
      continue
    }
    const heading = featureHeading.exec(trimmed)
    if (heading !== null) {
      close()
      draft = {
        id: heading[2] ?? "",
        name: (heading[1] ?? "").trim(),
        programs: [],
        context: [],
        scenarios: [],
        evidence: ""
      }
      section = "feature"
      continue
    }
    if (trimmed.startsWith("## ")) {
      close()
      section = trimmed === "## Open points" ? "open" : "other"
      continue
    }
    if (section === "other") {
      const inputs = /^inputs:\s*(\S+)\s*$/.exec(trimmed)
      if (inputs?.[1] !== undefined) {
        inputsHash = inputs[1]
      }
      continue
    }
    if (section === "open") {
      const violation = points.add(number, trimmed)
      if (violation !== undefined) {
        violations.push(violation)
      }
      continue
    }
    if (draft === undefined) {
      continue
    }
    const field = /^(programs|context|evidence):\s*(.*)$/.exec(trimmed)
    if (field !== null) {
      const value = field[2] ?? ""
      if (field[1] === "programs") {
        draft.programs = list(value)
      } else if (field[1] === "context") {
        draft.context = list(value)
      } else {
        draft.evidence = value.trim()
      }
      continue
    }
    if (trimmed.startsWith("- ")) {
      const match = scenarioLine.exec(trimmed)
      if (match === null) {
        violations.push(
          `line ${number}: scenario lines read \`- <program> / <title>\`, got: ${trimmed.slice(2)}`
        )
        continue
      }
      const mergedFrom = (match[3] ?? "")
        .split(";")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .flatMap((item) => {
          const slash = item.indexOf(" / ")
          return slash <= 0
            ? []
            : [ScenarioRef.make({ program: item.slice(0, slash), title: item.slice(slash + 3) })]
        })
      draft.scenarios.push(
        FeatureScenario.make({
          program: (match[1] ?? "").trim(),
          title: (match[2] ?? "").trim(),
          mergedFrom
        })
      )
    }
  }
  close()
  if (violations.length > 0) {
    return yield* DecisionsInvalid.make({ ...(path === undefined ? {} : { path }), violations })
  }
  return Domains.make({ features, inputsHash, openPoints: points.points, approved })
})

// ---- Proposal (model) ----------------------------------------------------------

export class ProposedScenario extends Schema.Class<ProposedScenario>("ProposedScenario")({
  program: Schema.String,
  title: Schema.String,
  mergedFrom: Schema.optionalKey(Schema.Array(ScenarioRef))
}) {}

export class ProposedFeature extends Schema.Class<ProposedFeature>("ProposedFeature")({
  id: Schema.String,
  name: Schema.String,
  programs: Schema.Array(Schema.String),
  scenarios: Schema.Array(ProposedScenario),
  evidence: Schema.String
}) {}

export class DomainProposal extends Schema.Class<DomainProposal>("DomainProposal")({
  features: Schema.Array(ProposedFeature),
  openPoints: Schema.Array(Schema.String)
}) {}

const scenarioRefJsonSchema: JsonSchema = {
  type: "object",
  properties: { program: { type: "string" }, title: { type: "string" } },
  required: ["program", "title"]
}

export const domainProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          programs: { type: "array", items: { type: "string" } },
          scenarios: {
            type: "array",
            items: {
              type: "object",
              properties: {
                program: { type: "string" },
                title: { type: "string" },
                mergedFrom: { type: "array", items: scenarioRefJsonSchema }
              },
              required: ["program", "title"]
            }
          },
          evidence: { type: "string" }
        },
        required: ["id", "name", "programs", "scenarios", "evidence"]
      }
    },
    openPoints: { type: "array", items: { type: "string" } }
  },
  required: ["features", "openPoints"]
}

/**
 * The consolidation ask: the deterministic clusters and every surviving
 * scenario, the rules the answer must keep (every scenario exactly once,
 * clusters may be split, joined, or folded only with evidence), and the
 * pack's stack-specific paragraph on what a feature is.
 */
export const consolidatePrompt = (
  clusters: ReadonlyArray<Cluster>,
  scenarios: ReadonlyMap<string, ReadonlySet<string>>,
  packParagraph?: string
): string => {
  const clusterLines = clusters.map(
    (cluster, index) =>
      `${index + 1}. ${cluster.shell ? "shell fragments" : "programs"}: ${cluster.programs.join(", ")}` +
      (cluster.context.length === 0 ? "" : ` (includes: ${cluster.context.join(", ")})`)
  )
  const scenarioLines = [...scenarios.entries()].flatMap(([program, titles]) => [
    `${program}:`,
    ...[...titles].map((title) => `  - ${title}`)
  ])
  return [
    "Name the domain features of this legacy estate and assign every surviving scenario to one.",
    "",
    "The clusters below were derived deterministically from the dependency graph (units that",
    "share a form target, a wizard, or a servlet; fragments attach as included context). Each",
    "cluster is a candidate feature. You may split a cluster, join two, or fold single-page",
    "clusters into one feature (e.g. a 'Portal shell and static pages' feature), but ONLY with",
    "evidence from the specs, stated in the feature's `evidence`.",
    "",
    "Rules:",
    "- Every scenario listed below appears EXACTLY once across the features, either as its own",
    "  line or inside another scenario's `mergedFrom` when two pages describe the same behaviour.",
    "- Feature names are business language; `id` is kebab-case and unique.",
    "- Anything you could not decide from the specs goes in `openPoints` as a question for the",
    "  human, never as a guess.",
    ...(packParagraph === undefined || packParagraph.trim().length === 0
      ? []
      : ["", packParagraph.trim()]),
    "",
    "Clusters:",
    ...clusterLines,
    "",
    "Surviving scenarios per program:",
    ...scenarioLines,
    "",
    'Respond only with JSON: {"features":[{"id":"…","name":"…","programs":["…"],',
    '"scenarios":[{"program":"…","title":"…","mergedFrom":[{"program":"…","title":"…"}]}],',
    '"evidence":"…"}],"openPoints":["…"]}'
  ].join("\n")
}

/** The map from a proposal: context comes from the clusters, open points are numbered. */
export const domainsFromProposal = (
  proposal: DomainProposal,
  clusters: ReadonlyArray<Cluster>,
  inputsHash: string
): Domains =>
  Domains.make({
    features: proposal.features.map((feature) => {
      const context = new Set<string>()
      for (const cluster of clusters) {
        if (cluster.programs.some((program) => feature.programs.includes(program))) {
          for (const fragment of cluster.context) {
            context.add(fragment)
          }
        }
      }
      return DomainFeature.make({
        id: feature.id,
        name: feature.name,
        programs: feature.programs,
        context: [...context].sort(),
        scenarios: feature.scenarios.map((scenario) =>
          FeatureScenario.make({
            program: scenario.program,
            title: scenario.title,
            mergedFrom: scenario.mergedFrom ?? []
          })
        ),
        evidence: feature.evidence
      })
    }),
    inputsHash,
    openPoints: proposal.openPoints.map((question, index) =>
      OpenPoint.make({ number: index + 1, question })
    ),
    approved: false
  })

/** Stable over key order; changes with any spec or the decisions text. */
export const domainsInputsHash = (
  specs: Readonly<Record<string, string>>,
  decisionsText: string
): string =>
  stableHash(
    [
      ...Object.entries(specs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, text]) => `${name}\n${text}`),
      decisionsText
    ].join("\n \n")
  )

// ---- Navigation order ----------------------------------------------------------

/**
 * The order a feature's pages convert in: pages no other page of the feature
 * reaches over a cluster edge first (the list before its edit form, step 1
 * before step 2), then breadth-first along those edges, ties and unreached
 * pages in the feature's own order. Edges through a shared non-page unit (a
 * form target both pages post to) say nothing about order and are ignored.
 */
export const navigationOrder = (
  feature: DomainFeature,
  graph: SurveyGraph,
  rules: ConsolidateRules
): ReadonlyArray<string> => {
  const pages = new Set(feature.programs)
  const edges = graph.edges.filter(
    (edge) =>
      kindMatches(edge.kind, rules.cluster) &&
      pages.has(edge.from) &&
      pages.has(edge.to) &&
      edge.from !== edge.to
  )
  const inbound = new Map(feature.programs.map((page) => [page, 0]))
  for (const edge of edges) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1)
  }
  const ordered: Array<string> = []
  const seen = new Set<string>()
  const queue = feature.programs.filter((page) => (inbound.get(page) ?? 0) === 0)
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || seen.has(current)) {
      continue
    }
    seen.add(current)
    ordered.push(current)
    for (const edge of edges) {
      if (edge.from === current && !seen.has(edge.to)) {
        queue.push(edge.to)
      }
    }
  }
  for (const page of feature.programs) {
    if (!seen.has(page)) {
      ordered.push(page)
    }
  }
  return ordered
}
