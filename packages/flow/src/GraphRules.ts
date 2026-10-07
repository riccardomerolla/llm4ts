import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PlanParseError } from "./FlowError.ts"
import { fingerprintOf } from "./ReviewCache.ts"
import type { CoverageRule } from "./SpecChecks.ts"
import type { JoinMatch } from "./Survey.ts"

/**
 * The pack's graph vocabulary (ADR 0030). A `## Node:` rule names a sub-file
 * node kind, an `## Edge:` rule a captured link, a `## Join:` rule a link by
 * attribute equality across files, a `## Probe:` a flow that must be
 * connected end to end. `## Survey:` rules are folded in as file-to-file
 * Edge rules so a pre-0030 pack produces the same graph.
 */
export class NodeRule extends Schema.Class<NodeRule>("NodeRule")({
  kind: Schema.String,
  files: Schema.String,
  pattern: Schema.String,
  descriptor: Schema.Boolean,
  anchor: Schema.optionalKey(Schema.String),
  /** `attr → named group` copies beyond the default "every group but name". */
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
export type JoinMatchMode = typeof JoinMatchMode.Type
export const JoinScope = Schema.Literals(["estate", "app", "file"])
export type JoinScope = typeof JoinScope.Type

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

const fail = (message: string): Effect.Effect<never, PlanParseError> =>
  Effect.fail(PlanParseError.make({ message }))

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

const attrCopies = (value: string | undefined): Readonly<Record<string, string>> =>
  Object.fromEntries(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .flatMap((item) => {
        const [attr, group] = item.split("=").map((part) => part.trim())
        return attr !== undefined && group !== undefined && attr.length > 0 && group.length > 0
          ? [[attr, group]]
          : []
      })
  )

const kindAndAttr = (value: string | undefined): readonly [string, string] | undefined => {
  const dot = (value ?? "").indexOf(".")
  if (value === undefined || dot <= 0 || dot === value.length - 1) {
    return undefined
  }
  return [value.slice(0, dot).trim(), value.slice(dot + 1).trim()]
}

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
        nodes.push(
          NodeRule.make({
            kind,
            files: fields.files,
            pattern: fields.pattern,
            descriptor: yes(fields.descriptor),
            ...(fields.anchor === undefined ? {} : { anchor: fields.anchor }),
            attrs: attrCopies(fields.attrs)
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
        const from = kindAndAttr(fields.from)
        const to = kindAndAttr(fields.to)
        if (from === undefined || to === undefined) {
          return yield* fail(`'${heading}' needs 'from: <kind>.<attr>' and 'to: <kind>.<attr>'`)
        }
        const match: JoinMatchMode = fields.match === "url" ? "url" : "exact"
        const scope: JoinScope =
          fields.scope === "file" || fields.scope === "app" || fields.scope === "estate"
            ? fields.scope
            : match === "url"
              ? "app"
              : "estate"
        joins.push(
          JoinRule.make({
            kind,
            fromKind: from[0],
            fromAttr: from[1],
            toKind: to[0],
            toAttr: to[1],
            match,
            scope
          })
        )
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

/** Every edge kind the rules can produce: captured kinds plus join kinds. */
export const edgeKindsOf = (rules: GraphRules): ReadonlySet<string> =>
  new Set([...rules.edges.map((rule) => rule.kind), ...rules.joins.map((rule) => rule.kind)])

/** Changes when any rule that shapes the graph changes; probes and budgets do not. */
export const graphRulesHash = (rules: GraphRules): string =>
  fingerprintOf([JSON.stringify({ n: rules.nodes, e: rules.edges, j: rules.joins })])

/** `${ctx}/a/b?x=1` → `/a/b`; `salva.do` → `/salva.do`; scheme, host and fragment dropped. */
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

/**
 * Servlet-spec matching of a normalised request against a `url-pattern`:
 * exact, then a `/*` prefix, then a `*.ext` extension. The extension case
 * reads the raw pattern, since normalising `*.do` would prefix a slash.
 */
export const matchUrl = (request: string, pattern: string): JoinMatch | undefined => {
  const trimmed = pattern.trim()
  if (trimmed.startsWith("*.")) {
    return request.endsWith(trimmed.slice(1)) ? "extension" : undefined
  }
  const target = normalizeUrl(trimmed)
  if (request === target) {
    return "exact"
  }
  if (target.endsWith("/*")) {
    const prefix = target.slice(0, -2)
    return request === prefix || request.startsWith(`${prefix}/`) ? "prefix" : undefined
  }
  return undefined
}
