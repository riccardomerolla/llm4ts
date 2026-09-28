import * as Effect from "effect/Effect"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import { type OperationAnalysis, schemaPaths, writeAnalyses } from "./Analysis.ts"
import type { AuthProfile, Environment, SecretSource } from "./Auth.ts"
import { callOperation, RequestInvalid } from "./Call.ts"
import { elementByName, type Operation, type WsdlCatalog } from "./Catalog.ts"
import {
  heuristicClass,
  type JudgedClass,
  type OperationClass,
  type OperationsFile
} from "./Classification.ts"
import {
  blockingIssues,
  checkDesign,
  designPaths,
  parseDesignFile,
  renderDesignFile
} from "./Design.ts"
import { proposeDesign, reviseDesign } from "./DesignProposal.ts"
import { readIfPresent, serviceDirectory, servicePaths } from "./Discover.ts"
import { instanceFromXml } from "./Instance.ts"
import { encodeMapping, mapService, renderMapping } from "./Mapping.ts"
import {
  collectSeeds,
  type Exchange,
  readExchanges,
  renderRequestFile,
  type SampleError,
  samplePaths,
  seedsForService
} from "./Samples.ts"
import type { SoapTransportShape } from "./Transport.ts"
import type { XmlElement } from "./Xml.ts"
import { isYamlMap, parseYaml } from "./Yaml.ts"

// soap-explore: the whole discovery half in one pass, stopping only where a
// person decides. Given a catalog it writes a request for every operation,
// calls the read operations once in producer-first order (values from one
// response seed the next request), and reports every gap with the command
// that closes it. Each step keeps what exists, so a rerun continues.
//
// Chained values are live only in memory: the call sends the value the
// service answered with, the request file on disk carries its masked form.

export const exploreRequestName = "happy-path"

/** First line of a request file soap-explore owns; deleting it hands the file to the user. */
export const exploreMarker =
  "# soap-explore: generated. Delete this line to keep your edits; soap-explore then leaves the file alone."

export const explorePaths = (service: string) => ({
  report: `${serviceDirectory(service)}/explore.md`
})

// ---------------------------------------------------------------------------
// Probe gate

export interface ProbeDecision {
  readonly operation: string
  readonly probe: boolean
  /** How a probe was allowed: a confirmed read, or provisional agreement. */
  readonly basis?: "confirmed" | "provisional"
  readonly reason: string
}

/**
 * Which operations the probe may call. Only reads, ever. A confirmed
 * operations.md decides alone; before confirmation, a provisional probe needs
 * dev or test, the file still saying read, the name heuristic saying read,
 * and the judgment saying read with an `act` decision. `judged` undefined
 * means no judgment seat is configured.
 */
export const probeDecisions = (options: {
  readonly catalog: WsdlCatalog
  readonly operations: OperationsFile | undefined
  readonly environment: Environment | undefined
  readonly judged: ReadonlyMap<string, JudgedClass | undefined> | undefined
}): ReadonlyArray<ProbeDecision> =>
  options.catalog.operations.map(({ name }): ProbeDecision => {
    const skip = (reason: string): ProbeDecision => ({ operation: name, probe: false, reason })
    if (options.environment === undefined) return skip("no auth.json: nothing is called")
    const file = options.operations
    const listed: OperationClass = file?.classes.get(name) ?? "unclassified"
    if (file?.confirmed === true) {
      if (listed === "read") {
        return { operation: name, probe: true, basis: "confirmed", reason: "confirmed read" }
      }
      return skip(
        listed === "mutating"
          ? "mutating: never probed"
          : "unclassified in operations.md: not callable"
      )
    }
    if (options.environment === "uat") return skip("uat: confirm operations.md before any call")
    if (listed !== "read") {
      return skip(
        listed === "mutating" ? "mutating: never probed" : "unclassified: confirm operations.md"
      )
    }
    const heuristic = heuristicClass(name)
    if (heuristic.class !== "read") {
      return skip(`heuristic says ${heuristic.class}: confirm operations.md to call it`)
    }
    if (options.judged === undefined) {
      return skip("no judgment seat (LLM4TS_JUDGMENT_PROVIDER): confirm operations.md to call it")
    }
    const judged = options.judged.get(name)
    if (judged === undefined) return skip("the judgment did not answer: confirm operations.md")
    if (judged.class !== "read" || judged.decision !== "act") {
      return skip(
        `judgment says ${judged.class} ${judged.confidence.toFixed(2)} (${judged.decision}): confirm operations.md`
      )
    }
    return {
      operation: name,
      probe: true,
      basis: "provisional",
      reason: `provisional read: heuristic and judgment agree (${judged.confidence.toFixed(2)})`
    }
  })

// ---------------------------------------------------------------------------
// Producer-first order

const fieldName = (path: string): string =>
  (path.split(".").pop() ?? path).replace(/\[\]$/, "").replace(/^@/, "")

/** Leaf field names of an element; `requiredOnly` drops optional ones and those under optional parents. */
export const leafNames = (
  catalog: WsdlCatalog,
  element: string | undefined,
  requiredOnly: boolean
): ReadonlySet<string> => {
  const declared = element === undefined ? undefined : elementByName(catalog, element)
  if (declared === undefined) return new Set()
  const paths = schemaPaths(catalog, declared)
  const optional = paths.filter((path) => path.optional).map((path) => path.path)
  return new Set(
    paths
      .filter(
        (path) =>
          path.leaf &&
          (!requiredOnly ||
            (!path.optional &&
              !optional.some(
                (prefix) => path.path.startsWith(`${prefix}.`) || path.path.startsWith(`${prefix}@`)
              )))
      )
      .map((path) => fieldName(path.path))
  )
}

export interface ChainLink {
  readonly producer: string
  readonly fields: ReadonlyArray<string>
}

export interface ProbePlan {
  readonly order: ReadonlyArray<string>
  /** Per consumer, the operations whose responses can fill its required fields. */
  readonly producers: ReadonlyMap<string, ReadonlyArray<ChainLink>>
}

/**
 * Order `names` so producers run first: A precedes B when a leaf of A's
 * response is a required input field of B. Kahn's algorithm; ties and cycles
 * resolve in catalog order.
 */
export const probeOrder = (catalog: WsdlCatalog, names: ReadonlyArray<string>): ProbePlan => {
  const operations = catalog.operations.filter((operation) => names.includes(operation.name))
  const producers = new Map<string, Array<ChainLink>>()
  for (const consumer of operations) {
    const needs = leafNames(catalog, consumer.input, true)
    const links: Array<ChainLink> = []
    for (const producer of operations) {
      if (producer === consumer) continue
      const gives = leafNames(catalog, producer.output, false)
      const fields = [...needs].filter((field) => gives.has(field))
      if (fields.length > 0) links.push({ producer: producer.name, fields })
    }
    producers.set(consumer.name, links)
  }
  const order: Array<string> = []
  const remaining = operations.map((operation) => operation.name)
  while (remaining.length > 0) {
    const ready =
      remaining.find((name) =>
        (producers.get(name) ?? []).every((link) => !remaining.includes(link.producer))
      ) ?? remaining[0]
    if (ready === undefined) break
    order.push(ready)
    remaining.splice(remaining.indexOf(ready), 1)
  }
  return { order, producers }
}

/** First value per field name in a response payload. */
export const payloadSeeds = (
  catalog: WsdlCatalog,
  operation: Operation,
  payload: XmlElement
): ReadonlyMap<string, string> => {
  const output =
    operation.output === undefined ? undefined : elementByName(catalog, operation.output)
  if (output === undefined) return new Map()
  const seeds = new Map<string, string>()
  for (const [key, value] of collectSeeds([instanceFromXml(catalog, output, payload).value])) {
    if (key === "#text") continue
    const name = key.replace(/^@/, "")
    if (!seeds.has(name)) seeds.set(name, value)
  }
  return seeds
}

// ---------------------------------------------------------------------------
// The probe

export type RequestState = "written" | "regenerated" | "kept"

export type Outcome =
  | { readonly kind: "called"; readonly detail: string; readonly findings: number }
  | { readonly kind: "recorded"; readonly detail: string }
  | { readonly kind: "not-called"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }

export interface OperationReport {
  readonly operation: string
  /** The class operations.md lists (proposed or confirmed). */
  readonly listed: OperationClass
  readonly decision: ProbeDecision
  readonly request: RequestState
  readonly outcome: Outcome
  /** Fields this run's responses filled in the request (names only). */
  readonly chained: ReadonlyArray<ChainLink>
}

export interface ExploreOptions {
  readonly workspace: WorkspaceShape
  readonly catalog: WsdlCatalog
  readonly service: string
  readonly profile: AuthProfile | undefined
  readonly operations: OperationsFile | undefined
  readonly judged: ReadonlyMap<string, JudgedClass | undefined> | undefined
  readonly secrets: SecretSource
  readonly transport: SoapTransportShape
  /** Call probed operations again even when an exchange exists. */
  readonly refresh: boolean
  readonly now?: () => Date
  readonly random?: (size: number) => Uint8Array
  /** Progress lines for the terminal (names and statuses only, never values). */
  readonly progress?: (line: string) => Effect.Effect<void>
}

export interface ExploreResult {
  readonly decisions: ReadonlyArray<ProbeDecision>
  readonly plan: ProbePlan
  readonly operations: ReadonlyArray<OperationReport>
}

const describeExchange = (exchange: Exchange): string =>
  exchange.fault !== undefined
    ? `fault ${exchange.fault.code} ${exchange.fault.reason}`
    : `HTTP ${exchange.response?.status ?? "?"}`

const withSeeds = (
  base: ReadonlyMap<string, string>,
  chained: ReadonlyMap<string, string>,
  fields: ReadonlySet<string>
): ReadonlyMap<string, string> => {
  const seeds = new Map(base)
  for (const field of fields) {
    const value = chained.get(field)
    if (value !== undefined) seeds.set(field, value)
  }
  return seeds
}

export const exploreService = (
  options: ExploreOptions
): Effect.Effect<ExploreResult, WorkspaceError | SampleError> =>
  Effect.gen(function* () {
    const { workspace, catalog, service } = options
    const progress = options.progress ?? (() => Effect.void)
    const decisions = probeDecisions({
      catalog,
      operations: options.operations,
      environment: options.profile?.environment,
      judged: options.judged
    })
    const probed = decisions.filter((decision) => decision.probe).map((d) => d.operation)
    const plan = probeOrder(catalog, probed)
    // The probe calls only operations it decided on, as confirmed reads.
    const probeFile: OperationsFile = {
      confirmed: true,
      classes: new Map(probed.map((name) => [name, "read" as const]))
    }
    const serviceSeeds = yield* seedsForService(workspace, catalog, service)
    const live = new Map<string, string>()
    const masked = new Map<string, string>()
    // Which operation's response supplied each chained field.
    const suppliedBy = new Map<string, string>()
    const reports = new Map<string, OperationReport>()

    /**
     * Write the request when absent; regenerate one explore owns only before
     * calling it. A file the user owns (no marker line, or the XML form) is
     * never touched.
     */
    const ensureRequest = (
      operation: Operation,
      chainedFields: ReadonlySet<string>,
      notes: ReadonlyArray<string>,
      regenerate: boolean
    ) =>
      Effect.gen(function* () {
        const paths = samplePaths(service, operation.name, exploreRequestName)
        const yaml = yield* readIfPresent(workspace, paths.yaml)
        const xml = yield* readIfPresent(workspace, paths.xml)
        if (
          xml !== undefined ||
          (yaml !== undefined && (!regenerate || !yaml.startsWith(exploreMarker)))
        ) {
          return "kept" as const
        }
        const text = renderRequestFile({
          catalog,
          operation: operation.name,
          purpose: "happy path",
          seeds: withSeeds(serviceSeeds, masked, chainedFields)
        })
        yield* workspace.write(paths.yaml, [exploreMarker, ...notes, text].join("\n"))
        return yaml === undefined ? ("written" as const) : ("regenerated" as const)
      })

    for (const name of plan.order) {
      const operation = catalog.operations.find((candidate) => candidate.name === name)
      const decision = decisions.find((candidate) => candidate.operation === name)
      if (operation === undefined || decision === undefined) continue
      const listed = options.operations?.classes.get(name) ?? "unclassified"
      const paths = samplePaths(service, name, exploreRequestName)
      const recorded = yield* readIfPresent(workspace, paths.exchange)
      const links = (plan.producers.get(name) ?? [])
        .map((link) => ({
          ...link,
          fields: link.fields.filter((field) => suppliedBy.get(field) === link.producer)
        }))
        .filter((link) => link.fields.length > 0)
      const chainedFields = new Set(links.flatMap((link) => link.fields))

      if (recorded !== undefined && !options.refresh) {
        const request = yield* ensureRequest(operation, new Set(), [], false)
        reports.set(name, {
          operation: name,
          listed,
          decision,
          request,
          outcome: { kind: "recorded", detail: "recorded earlier; --refresh calls it again" },
          chained: []
        })
        continue
      }

      const notes =
        links.length === 0
          ? []
          : [
              `# Chained at probe time: ${links.map((link) => `${link.fields.join(", ")} from ${link.producer}`).join("; ")}.`,
              "# Personal values appear masked here; soap-explore sent the live ones and never stores them."
            ]
      const request = yield* ensureRequest(operation, chainedFields, notes, true)
      // A file explore owns is sent with the live chained values; the file on
      // disk keeps the masked ones. A user's file is sent as written.
      const override =
        request === "kept" || chainedFields.size === 0
          ? undefined
          : yield* parseYaml(
              renderRequestFile({
                catalog,
                operation: name,
                purpose: "happy path",
                seeds: withSeeds(serviceSeeds, live, chainedFields)
              })
            ).pipe(Effect.option)
      const body =
        override !== undefined && override._tag === "Some" && isYamlMap(override.value)
          ? override.value["body"]
          : undefined

      const outcome = yield* callOperation({
        workspace,
        catalog,
        service,
        operation: name,
        name: exploreRequestName,
        profile: options.profile,
        operations: probeFile,
        secrets: options.secrets,
        transport: options.transport,
        allowMutating: undefined,
        confirm: () => Effect.succeed(false),
        ...(body === undefined
          ? {}
          : { request: { purpose: "happy path", body, form: "yaml" as const, readIssues: [] } }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.random === undefined ? {} : { random: options.random })
      }).pipe(Effect.result)

      let result: Outcome
      if (outcome._tag === "Failure") {
        // A request that did not validate may carry live chained values in
        // its issue text: report where, never what.
        const error = outcome.failure
        result = {
          kind: "failed",
          detail:
            error instanceof RequestInvalid
              ? `not sent, the request does not validate at ${error.issues.map((issue) => issue.path).join(", ")}`
              : error.message
        }
      } else {
        const { exchange, payload } = outcome.success
        result = {
          kind: "called",
          detail: `${describeExchange(exchange)}, ${exchange.response?.elapsedMs ?? 0} ms`,
          findings: exchange.responseIssues.length
        }
        if (payload !== undefined) {
          for (const [field, value] of payloadSeeds(catalog, operation, payload.live)) {
            if (!live.has(field)) {
              live.set(field, value)
              suppliedBy.set(field, name)
            }
          }
          for (const [field, value] of payloadSeeds(catalog, operation, payload.masked)) {
            if (!masked.has(field)) masked.set(field, value)
          }
        }
      }
      yield* progress(
        `${name}: ${result.detail}${links.length === 0 ? "" : ` (chained ${[...chainedFields].join(", ")})`}`
      )
      reports.set(name, {
        operation: name,
        listed,
        decision,
        request,
        outcome: result,
        chained: links
      })
    }

    // Every other operation gets a request to edit, seeded with what the
    // probe learnt (masked), and the reason it was not called.
    for (const operation of catalog.operations) {
      if (reports.has(operation.name)) continue
      const decision = decisions.find((candidate) => candidate.operation === operation.name)
      if (decision === undefined) continue
      const needs = leafNames(catalog, operation.input, true)
      const request = yield* ensureRequest(
        operation,
        new Set([...needs].filter((field) => masked.has(field))),
        [],
        false
      )
      const recorded = yield* readIfPresent(
        workspace,
        samplePaths(service, operation.name, exploreRequestName).exchange
      )
      reports.set(operation.name, {
        operation: operation.name,
        listed: options.operations?.classes.get(operation.name) ?? "unclassified",
        decision,
        request,
        outcome:
          recorded === undefined
            ? { kind: "not-called", detail: decision.reason }
            : { kind: "recorded", detail: "recorded earlier" },
        chained: []
      })
    }

    return {
      decisions,
      plan,
      operations: catalog.operations.flatMap((operation) => {
        const report = reports.get(operation.name)
        return report === undefined ? [] : [report]
      })
    }
  })

// ---------------------------------------------------------------------------
// Evidence and design

export type DesignState =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly detail: string }
  | {
      readonly kind: "drafted" | "revised" | "checked"
      readonly approved: boolean
      readonly errors: number
      readonly warnings: number
    }

export interface EvidenceResult {
  readonly analyses: ReadonlyArray<OperationAnalysis>
  readonly exchanges: number
}

/** analysis/<op>.md for every operation, then design/mapping.json + .md. */
export const writeEvidence = (
  workspace: WorkspaceShape,
  catalog: WsdlCatalog,
  service: string
): Effect.Effect<EvidenceResult, WorkspaceError | SampleError> =>
  Effect.gen(function* () {
    const analyses = yield* writeAnalyses(workspace, catalog, service)
    const mapping = mapService(catalog)
    const paths = designPaths(serviceDirectory(service))
    yield* workspace.write(paths.mapping, encodeMapping(mapping))
    yield* workspace.write(paths.mappingSummary, renderMapping(mapping))
    const exchanges = (yield* readExchanges(workspace, service)).length
    return { analyses, exchanges }
  })

/**
 * The design step: an existing api-design.md is only checked; otherwise,
 * with evidence and a reasoning seat, draft it, check it, and revise once
 * when errors remain. The file is always written as proposed.
 */
export const designStep = (options: {
  readonly workspace: WorkspaceShape
  readonly catalog: WsdlCatalog
  readonly service: string
  readonly operations: OperationsFile | undefined
  readonly evidence: EvidenceResult
  /** The drafting seat, or `{ off }` with the reason drafting is off (`--no-design`). */
  readonly reasoning: LlmServiceShape | { readonly off: string }
  readonly style: string
}): Effect.Effect<DesignState, WorkspaceError> =>
  Effect.gen(function* () {
    const { workspace, catalog, operations } = options
    const analyses = options.evidence.analyses
    const paths = designPaths(serviceDirectory(options.service))
    const existing = yield* readIfPresent(workspace, paths.design)
    if (existing !== undefined) {
      const file = yield* parseDesignFile(existing).pipe(Effect.result)
      if (file._tag === "Failure") return { kind: "failed", detail: file.failure.message }
      const issues = checkDesign(file.success.design, { catalog, operations, analyses })
      yield* workspace.write(
        paths.design,
        renderDesignFile(
          file.success.design,
          issues,
          file.success.approved ? "approved" : "proposed"
        )
      )
      const errors = blockingIssues(issues).length
      return {
        kind: "checked",
        approved: file.success.approved,
        errors,
        warnings: issues.length - errors
      }
    }
    if ("off" in options.reasoning) return { kind: "skipped", reason: options.reasoning.off }
    if (options.evidence.exchanges === 0) {
      return { kind: "skipped", reason: "no exchanges yet: the design needs evidence" }
    }
    const reasoning = options.reasoning
    const base = {
      catalog,
      operations,
      mapping: mapService(catalog),
      analyses,
      style: options.style
    }
    const drafted = yield* proposeDesign(reasoning, base).pipe(Effect.result)
    if (drafted._tag === "Failure") {
      return { kind: "failed", detail: `drafting failed: ${drafted.failure.message}` }
    }
    let design = drafted.success
    let issues = checkDesign(design, { catalog, operations, analyses })
    let kind: "drafted" | "revised" = "drafted"
    if (blockingIssues(issues).length > 0) {
      const revised = yield* reviseDesign(reasoning, { ...base, current: design, issues }).pipe(
        Effect.result
      )
      if (revised._tag === "Success") {
        design = revised.success
        issues = checkDesign(design, { catalog, operations, analyses })
        kind = "revised"
      }
    }
    yield* workspace.write(paths.design, renderDesignFile(design, issues, "proposed"))
    const errors = blockingIssues(issues).length
    return { kind, approved: false, errors, warnings: issues.length - errors }
  })

// ---------------------------------------------------------------------------
// Report

const outcomeText = (outcome: Outcome): string =>
  outcome.kind === "called"
    ? `called: ${outcome.detail}${outcome.findings === 0 ? "" : `, ${outcome.findings} schema findings`}`
    : `${outcome.kind}: ${outcome.detail}`

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ")

export const renderExploreReport = (options: {
  readonly service: string
  readonly catalog: WsdlCatalog
  readonly profile: AuthProfile | undefined
  readonly operations: OperationsFile | undefined
  readonly result: ExploreResult
  readonly design: DesignState
  readonly evidence: EvidenceResult
}): string => {
  const { service, catalog, result, design } = options
  const paths = servicePaths(service)
  const lines: Array<string> = [
    `# Explore: ${service}`,
    "",
    "Regenerated by every `soap-explore` run. Every value in the files it points at is masked.",
    "",
    `- operations: ${catalog.operations.length}, open questions: ${catalog.openQuestions.length} (see catalog.md)`,
    `- environment: ${options.profile?.environment ?? "none (no auth.json)"}`,
    `- operations.md: ${options.operations === undefined ? "missing" : options.operations.confirmed ? "confirmed" : "proposed"}`,
    `- exchanges recorded: ${options.evidence.exchanges}`,
    "",
    "## Operations",
    "",
    "| Operation | Class | Probe | Request | Result |",
    "| --- | --- | --- | --- | --- |"
  ]
  for (const report of result.operations) {
    const request = `samples/${report.operation}/${exploreRequestName} (${report.request})`
    lines.push(
      `| ${cell(report.operation)} | ${report.listed}${options.operations?.confirmed === true ? "" : " (proposed)"} | ${report.decision.probe ? `yes, ${report.decision.basis ?? ""}` : "no"} | ${cell(request)} | ${cell(report.decision.probe ? outcomeText(report.outcome) : report.outcome.kind === "recorded" ? outcomeText(report.outcome) : `not called: ${report.decision.reason}`)} |`
    )
  }
  const chained = result.operations.filter((report) => report.chained.length > 0)
  if (chained.length > 0) {
    lines.push("", "## Chained values", "")
    for (const report of chained) {
      lines.push(
        `- ${report.operation} ← ${report.chained.map((link) => `${link.producer} (${link.fields.join(", ")})`).join("; ")}`
      )
    }
  }
  lines.push("", "## Design", "")
  switch (design.kind) {
    case "skipped":
      lines.push(`Not drafted: ${design.reason}.`)
      break
    case "failed":
      lines.push(`Not drafted: ${design.detail}`)
      break
    default:
      lines.push(
        `design/api-design.md ${design.kind}: ${design.approved ? "approved" : "proposed"}, ${design.errors} errors, ${design.warnings} warnings.`
      )
  }

  const next: Array<string> = []
  if (options.profile === undefined) {
    next.push(
      `Write \`${paths.auth}\` to enable calls, at least \`{"environment": "test"}\` (dev, test, or uat; add "endpoint" when the WSDL names another environment, and auth by env:/file: reference). Then rerun soap-explore.`
    )
  }
  if (options.operations !== undefined && !options.operations.confirmed) {
    next.push(
      `Review the classes in \`${paths.operations}\` and set \`Status: confirmed\`; then rerun soap-explore to probe every read operation.`
    )
  }
  for (const report of result.operations) {
    if (report.outcome.kind === "failed") {
      next.push(
        `${report.operation}: fix \`samples/${report.operation}/${exploreRequestName}.request.yaml\` (delete its first line to keep your edits), then \`soap-sample "call ${report.operation}/${exploreRequestName}"\`.`
      )
    }
  }
  const mutating = result.operations
    .filter((report) => report.listed === "mutating" && report.outcome.kind === "not-called")
    .map((report) => report.operation)
  if (options.profile !== undefined && mutating.length > 0) {
    next.push(
      `Mutating operations are never probed (${mutating.join(", ")}): edit a request, then \`soap-sample -- --allow-mutating <operation> "call <operation>/${exploreRequestName}"\` when a test call is acceptable.`
    )
  }
  if (options.evidence.exchanges > 0) {
    next.push(
      'More evidence per operation (empty result, business fault, paging): `soap-sample "propose <operation>"`, then `soap-sample "call <operation>"`, then rerun soap-explore.'
    )
  }
  if (design.kind === "skipped" || design.kind === "failed") {
    if (options.evidence.exchanges > 0) next.push('Draft the design: `soap-design "design"`.')
  } else if (!design.approved) {
    next.push(
      'Review `design/api-design.md`, run `soap-design "check"` until it has no errors, set `Status: approved`, then `soap-design "openapi"` and `soap-epic`.'
    )
  } else if (design.errors === 0) {
    next.push(
      'The design is approved: `soap-design "openapi"`, then `soap-epic -- --target <ace-repo> plan`.'
    )
  }
  lines.push("", "## Next", "", ...next.map((line) => `- ${line}`), "")
  return lines.join("\n")
}
