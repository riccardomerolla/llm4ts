import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ContractConflict, PlanParseError } from "./FlowError.ts"

export { ContractConflict } from "./FlowError.ts"

// The Page Spec is the per-page contract of the J2EE→SPA conversion scenario
// (ADR 0012): extraction embeds it in the spec markdown as a ```json pagespec
// fenced block, conversion decodes it here and derives the anti-corruption
// contract from its API section. It rides inside the existing extract
// artifacts rather than adding a fifth artifact stream, so modernize-extract
// stays untouched and the judge sees spec and page-spec as one document.

export const PageSpecVersion = 1

export const ValidationSite = Schema.Literals(["client", "server", "both"])
export type ValidationSite = typeof ValidationSite.Type

const emptyStrings: ReadonlyArray<string> = Object.freeze([])

export class PageValidation extends Schema.Class<PageValidation>("PageValidation")({
  rule: Schema.String,
  message: Schema.optionalKey(Schema.String),
  enforcedAt: ValidationSite
}) {}

const emptyValidations: ReadonlyArray<PageValidation> = Object.freeze([])

export class PageFormField extends Schema.Class<PageFormField>("PageFormField")({
  name: Schema.String,
  label: Schema.String,
  type: Schema.String,
  required: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  validations: Schema.Array(PageValidation).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyValidations)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyValidations))
  )
}) {}

export class PageForm extends Schema.Class<PageForm>("PageForm")({
  name: Schema.String,
  action: Schema.String,
  fields: Schema.Array(PageFormField)
}) {}

/** One legacy field renamed into domain language — the anti-corruption table. */
export class FieldMapping extends Schema.Class<FieldMapping>("FieldMapping")({
  legacyName: Schema.String,
  domainName: Schema.String,
  type: Schema.String
}) {}

const emptyMappings: ReadonlyArray<FieldMapping> = Object.freeze([])

export class PageDto extends Schema.Class<PageDto>("PageDto")({
  legacyName: Schema.String,
  domainName: Schema.String,
  fields: Schema.Array(FieldMapping)
}) {}

export const ResponseShape = Schema.Literals(["single", "list"])
export type ResponseShape = typeof ResponseShape.Type

export class PageApiCall extends Schema.Class<PageApiCall>("PageApiCall")({
  /** Domain operation id, e.g. `listAccounts` — becomes the OpenAPI operationId. */
  operation: Schema.String,
  method: Schema.String,
  path: Schema.String,
  /** The ESB service behind the legacy endpoint, when known. */
  /** An ESB service identifier (`ESB_ACCT_LIST`), never prose: unknown means omit. */
  esbService: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:/-]+$/))),
  request: Schema.Array(FieldMapping).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyMappings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyMappings))
  ),
  /**
   * The response's fields when it is an ad-hoc object. A response that is
   * one of the page's DTOs names it with `responseDto` instead — the
   * `domainName` of an entry in `dtos` — and `responseShape` says whether
   * the endpoint returns one of them or a list; a table screen is a list.
   */
  response: Schema.Array(FieldMapping).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyMappings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyMappings))
  ),
  responseDto: Schema.optionalKey(Schema.String),
  responseShape: ResponseShape.pipe(
    Schema.withConstructorDefault(Effect.succeed("single" as const)),
    Schema.withDecodingDefaultKey(Effect.succeed("single" as const))
  )
}) {}

export class PageNavigation extends Schema.Class<PageNavigation>("PageNavigation")({
  inbound: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyStrings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyStrings))
  ),
  outbound: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyStrings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyStrings))
  ),
  /** Multi-step flows: the page names in order, when this page is one step. */
  steps: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyStrings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyStrings))
  )
}) {}

export const PageComplexity = Schema.Literals(["low", "medium", "high"])
export type PageComplexity = typeof PageComplexity.Type

const emptyForms: ReadonlyArray<PageForm> = Object.freeze([])
const emptyDtos: ReadonlyArray<PageDto> = Object.freeze([])
const emptyCalls: ReadonlyArray<PageApiCall> = Object.freeze([])

export class PageSpec extends Schema.Class<PageSpec>("PageSpec")({
  /** The program name keying every artifact — matches `specs/<page>.md`. */
  page: Schema.String,
  route: Schema.String,
  title: Schema.String,
  complexity: PageComplexity,
  forms: Schema.Array(PageForm).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyForms)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyForms))
  ),
  dtos: Schema.Array(PageDto).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyDtos)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyDtos))
  ),
  apiCalls: Schema.Array(PageApiCall).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyCalls)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyCalls))
  ),
  navigation: PageNavigation.pipe(
    Schema.withConstructorDefault(Effect.sync(() => PageNavigation.make({}))),
    Schema.withDecodingDefaultKey(Effect.sync(() => PageNavigation.make({})))
  ),
  sessionState: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyStrings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyStrings))
  ),
  openQuestions: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyStrings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyStrings))
  )
}) {}

/**
 * The block's shape in one paragraph, for the finding an undecodable block
 * raises: the analyst that wrote its own richer shape is told exactly which
 * keys the decoder accepts instead of only where decoding stopped.
 */
export const pageSpecShapeHint =
  "The block must be exactly: { page, route, title, complexity: low|medium|high, " +
  "forms: [{ name, action, fields: [{ name, label, type, required?, validations: [{ rule, message?, enforcedAt: client|server|both }] }] }], " +
  "dtos: [{ legacyName, domainName, fields: [{ legacyName, domainName, type }] }], " +
  "apiCalls: [{ operation, method, path, esbService (the identifier of the ESB service the legacy call goes through, such as ESB_ACCT_LIST — omit it when unknown or absent; never a sentence), request: [{ legacyName, domainName, type }], response: [{ legacyName, domainName, type }] for an ad-hoc object, or responseDto: <domainName of one of the dtos> with responseShape: single|list when the endpoint returns that DTO or a list of it (a table screen is a list) }], " +
  "navigation: { inbound: [string], outbound: [string], steps: [string] }, sessionState: [string], openQuestions: [string] }. " +
  "No other keys (no id, url, queryParams, esbCall, trigger, serverController); every apiCalls entry is an object with operation/method/path; " +
  "put anything that does not fit into the prose sections or openQuestions."

/** The fence info string marking a page-spec block inside spec markdown. */
export const pageSpecFenceInfo = "json pagespec"

const fencePattern = /```json[ \t]+pagespec[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/

/** The raw JSON of the first ```json pagespec fenced block, if any. */
export const pageSpecBlock = (markdown: string): string | undefined =>
  fencePattern.exec(markdown)?.[1]

/**
 * Decodes the page spec embedded in a spec markdown document. A missing block
 * and a malformed one are both `PlanParseError`s — the extraction gate treats
 * either as an incomplete extraction, never as "no spec needed".
 */
export const parsePageSpec = Effect.fn("@llm4ts/flow/PageSpec.parse")(function* (
  markdown: string
): Effect.fn.Return<PageSpec, PlanParseError> {
  const block = pageSpecBlock(markdown)
  if (block === undefined) {
    return yield* PlanParseError.make({
      message: "no ```json pagespec fenced block in the spec markdown"
    })
  }
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PageSpec))(block).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `invalid page spec block: ${String(error)}`
      })
    )
  )
})

/** Renders a spec as a ```json pagespec fenced block — the inverse of `parsePageSpec`. */
export const renderPageSpecBlock = Effect.fn("@llm4ts/flow/PageSpec.renderBlock")(function* (
  spec: PageSpec
): Effect.fn.Return<string, PlanParseError> {
  const encoded = yield* Schema.encodeEffect(PageSpec)(spec).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `failed to encode page spec: ${String(error)}`
      })
    )
  )
  return `\`\`\`${pageSpecFenceInfo}\n${JSON.stringify(encoded, undefined, 2)}\n\`\`\``
})

const openApiType = (type: string): { readonly type: string; readonly format?: string } => {
  const lowered = type.toLowerCase()
  if (/int|number|decimal|amount|count/.test(lowered)) {
    return { type: "number" }
  }
  if (/bool/.test(lowered)) {
    return { type: "boolean" }
  }
  if (/datetime|timestamp/.test(lowered)) {
    return { type: "string", format: "date-time" }
  }
  if (/date/.test(lowered)) {
    return { type: "string", format: "date" }
  }
  return { type: "string" }
}

const yamlText = (value: string): string => JSON.stringify(value)

const schemaName = (operation: string, side: "Request" | "Response"): string =>
  `${operation.charAt(0).toUpperCase()}${operation.slice(1)}${side}`

const dtoSchemaName = (domainName: string): string =>
  domainName.replace(/[^A-Za-z0-9]+/g, "") || "Dto"

const propertyLines = (
  fields: ReadonlyArray<FieldMapping>,
  indent: string
): ReadonlyArray<string> =>
  fields.flatMap((field) => {
    const mapped = openApiType(field.type)
    return [
      `${indent}${field.domainName}:`,
      `${indent}  type: ${mapped.type}`,
      ...(mapped.format === undefined ? [] : [`${indent}  format: ${mapped.format}`]),
      `${indent}  description: ${yamlText(`legacy: ${field.legacyName}`)}`
    ]
  })

/**
 * Deterministic OpenAPI 3.0 fragment for the page's API calls, in DOMAIN
 * names — the anti-corruption contract the port, the mock adapter, and a
 * future B4F implement. Emitted by code, not by a model: the contract must
 * be a projection of the reviewed page spec, never an invention.
 */
interface ContractInfo {
  readonly title: string
  readonly description: string
}

/** The YAML writer shared by the per-page and the per-feature contracts. */
const renderOpenApi = (
  info: ContractInfo,
  apiCalls: ReadonlyArray<PageApiCall>,
  dtos: ReadonlyArray<PageDto>,
  origins?: ReadonlyMap<string, ReadonlyArray<string>>
): string => {
  const byPath = new Map<string, Array<PageApiCall>>()
  for (const call of apiCalls) {
    const bucket = byPath.get(call.path) ?? []
    bucket.push(call)
    byPath.set(call.path, bucket)
  }
  const paths = [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right))
  const lines: Array<string> = [
    "openapi: 3.0.3",
    "info:",
    `  title: ${yamlText(info.title)}`,
    `  description: ${yamlText(info.description)}`,
    "  version: 0.1.0",
    "paths:"
  ]
  if (paths.length === 0) {
    lines[lines.length - 1] = "paths: {}"
  }
  for (const [path, calls] of paths) {
    lines.push(`  ${path.startsWith("/") ? path : `/${path}`}:`)
    // One operation per method: an OpenAPI path item cannot repeat a method,
    // so calls that share one (a page load and its JSON refresh on the same
    // GET) collapse into the first, which names the variants it stands for.
    const byMethod = new Map<string, Array<PageApiCall>>()
    for (const call of calls) {
      const method = call.method.toLowerCase()
      byMethod.set(method, [...(byMethod.get(method) ?? []), call])
    }
    for (const [method, variants] of [...byMethod.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      const call = variants[0]!
      lines.push(`    ${method}:`)
      lines.push(`      operationId: ${call.operation}`)
      const origin = origins?.get(`${call.method.toUpperCase()} ${call.path}`)
      const notes = [
        ...(call.esbService === undefined ? [] : [`backed by ESB service ${call.esbService}`]),
        ...(origin === undefined
          ? []
          : [`declared by page${origin.length > 1 ? "s" : ""} ${origin.join(", ")}`]),
        ...(variants.length > 1
          ? [
              `also serves: ${variants
                .slice(1)
                .map((variant) => variant.operation)
                .join(", ")}`
            ]
          : [])
      ]
      if (notes.length > 0) {
        lines.push(`      description: ${yamlText(notes.join("; "))}`)
      }
      if (call.request.length > 0 && method === "get") {
        lines.push("      parameters:")
        for (const field of call.request) {
          const mapped = openApiType(field.type)
          lines.push(`        - name: ${field.domainName}`)
          lines.push("          in: query")
          lines.push("          schema:")
          lines.push(`            type: ${mapped.type}`)
        }
      }
      if (call.request.length > 0 && method !== "get") {
        lines.push("      requestBody:")
        lines.push("        required: true")
        lines.push("        content:")
        lines.push("          application/json:")
        lines.push("            schema:")
        lines.push(
          `              $ref: "#/components/schemas/${schemaName(call.operation, "Request")}"`
        )
      }
      lines.push("      responses:")
      lines.push('        "200":')
      lines.push(`          description: ${yamlText(`${call.operation} result`)}`)
      lines.push("          content:")
      lines.push("            application/json:")
      lines.push("              schema:")
      const responseRef = `"#/components/schemas/${
        call.responseDto === undefined
          ? schemaName(call.operation, "Response")
          : dtoSchemaName(call.responseDto)
      }"`
      if (call.responseShape === "list") {
        lines.push("                type: array")
        lines.push("                items:")
        lines.push(`                  $ref: ${responseRef}`)
      } else {
        lines.push(`                $ref: ${responseRef}`)
      }
    }
  }
  lines.push("components:")
  lines.push("  schemas:")
  const schemaCalls = [...apiCalls].sort((a, b) => a.operation.localeCompare(b.operation))
  let wroteSchema = false
  // Every DTO a response names becomes a component the calls reference —
  // one schema per domain entity, shared by every endpoint returning it.
  const referencedDtos = new Set(
    apiCalls.flatMap((call) => (call.responseDto === undefined ? [] : [call.responseDto]))
  )
  for (const dto of [...dtos].sort((a, b) => a.domainName.localeCompare(b.domainName))) {
    if (!referencedDtos.has(dto.domainName)) {
      continue
    }
    wroteSchema = true
    lines.push(`    ${dtoSchemaName(dto.domainName)}:`)
    lines.push("      type: object")
    lines.push(`      description: ${yamlText(`legacy: ${dto.legacyName}`)}`)
    lines.push("      properties:")
    lines.push(...propertyLines(dto.fields, "        "))
  }
  for (const call of schemaCalls) {
    for (const [side, fields] of [
      ["Request", call.request],
      ["Response", call.response]
    ] as const) {
      if (side === "Request" && (fields.length === 0 || call.method.toLowerCase() === "get")) {
        continue
      }
      if (side === "Response" && call.responseDto !== undefined) {
        continue
      }
      wroteSchema = true
      lines.push(`    ${schemaName(call.operation, side)}:`)
      lines.push("      type: object")
      if (fields.length === 0) {
        lines.push("      properties: {}")
      } else {
        lines.push("      properties:")
        lines.push(...propertyLines(fields, "        "))
      }
    }
  }
  if (!wroteSchema) {
    lines[lines.length - 1] = "  schemas: {}"
  }
  return lines.join("\n") + "\n"
}

export const openApiFor = (spec: PageSpec): string =>
  renderOpenApi(
    {
      title: `${spec.title} service contract`,
      description: `Anti-corruption contract for page ${spec.page} (${spec.route})`
    },
    spec.apiCalls,
    spec.dtos
  )

const sameFields = (
  left: ReadonlyArray<FieldMapping>,
  right: ReadonlyArray<FieldMapping>
): boolean =>
  left.length === right.length &&
  left.every(
    (field, index) =>
      field.legacyName === right[index]?.legacyName &&
      field.domainName === right[index]?.domainName &&
      field.type === right[index]?.type
  )

const sameCall = (left: PageApiCall, right: PageApiCall): boolean =>
  left.operation === right.operation &&
  left.responseDto === right.responseDto &&
  left.responseShape === right.responseShape &&
  sameFields(left.request, right.request) &&
  sameFields(left.response, right.response)

export interface FeatureContract {
  readonly yaml: string
  /** `<method> <path>` of every operation and the pages that declare it. */
  readonly operations: ReadonlyArray<{
    readonly key: string
    readonly pages: ReadonlyArray<string>
  }>
}

/**
 * ONE contract for a domain feature (ADR 0012 addendum): the union of its
 * pages' API sections by method + path, DTOs by domain name. Two pages that
 * declare the same method + path (or the same operation name) with different
 * shapes, or the same DTO with different fields, are a `ContractConflict`
 * listing every disagreement — never a silent merge. The page each
 * operation came from is recorded in its description.
 */
export const openApiForFeature = (
  feature: { readonly id: string; readonly name: string },
  specs: ReadonlyArray<PageSpec>
): Effect.Effect<FeatureContract, ContractConflict> => {
  const conflicts: Array<string> = []
  const calls = new Map<string, { call: PageApiCall; pages: Array<string> }>()
  const byOperation = new Map<string, string>()
  for (const spec of specs) {
    for (const call of spec.apiCalls) {
      const key = `${call.method.toUpperCase()} ${call.path}`
      const existing = calls.get(key)
      if (existing === undefined) {
        const owner = byOperation.get(call.operation)
        if (owner !== undefined && owner !== key) {
          conflicts.push(
            `operation '${call.operation}' is declared on ${owner} and on ${key} (${spec.page})`
          )
          continue
        }
        byOperation.set(call.operation, key)
        calls.set(key, { call, pages: [spec.page] })
      } else if (sameCall(existing.call, call)) {
        existing.pages.push(spec.page)
      } else {
        conflicts.push(
          `${key} differs between ${existing.pages.join(", ")} (${existing.call.operation}) and ${spec.page} (${call.operation})`
        )
      }
    }
  }
  const dtos = new Map<string, { dto: PageDto; page: string }>()
  for (const spec of specs) {
    for (const dto of spec.dtos) {
      const existing = dtos.get(dto.domainName)
      if (existing === undefined) {
        dtos.set(dto.domainName, { dto, page: spec.page })
      } else if (!sameFields(existing.dto.fields, dto.fields)) {
        conflicts.push(
          `DTO '${dto.domainName}' has different fields in ${existing.page} and ${spec.page}`
        )
      }
    }
  }
  if (conflicts.length > 0) {
    return Effect.fail(ContractConflict.make({ feature: feature.id, conflicts }))
  }
  const operations = [...calls.entries()].map(([key, { pages }]) => ({ key, pages }))
  const yaml = renderOpenApi(
    {
      title: `${feature.name} service contract`,
      description:
        `Anti-corruption contract for domain feature ${feature.id} — pages ` +
        specs.map((spec) => spec.page).join(", ")
    },
    [...calls.values()].map(({ call }) => call),
    [...dtos.values()].map(({ dto }) => dto),
    new Map(operations.map(({ key, pages }) => [key, pages]))
  )
  return Effect.succeed({ yaml, operations })
}

/** Human-readable summary — the review surface next to the JSON contract. */
export const renderPageSpec = (spec: PageSpec): string => {
  const lines: Array<string> = [
    `# Page: ${spec.page}`,
    "",
    `- Route: ${spec.route}`,
    `- Title: ${spec.title}`,
    `- Complexity: ${spec.complexity}`
  ]
  for (const form of spec.forms) {
    lines.push("", `## Form: ${form.name} → ${form.action}`)
    for (const field of form.fields) {
      const rules = field.validations
        .map((validation) => `${validation.rule} (${validation.enforcedAt})`)
        .join(", ")
      lines.push(
        `- ${field.name} (${field.type})${field.required ? " required" : ""}` +
          (rules.length === 0 ? "" : ` — ${rules}`)
      )
    }
  }
  if (spec.apiCalls.length > 0) {
    lines.push("", "## API calls")
    for (const call of spec.apiCalls) {
      const esb = call.esbService === undefined ? "" : ` — ESB ${call.esbService}`
      const returns =
        call.responseDto === undefined
          ? ""
          : ` → ${call.responseShape === "list" ? `list of ${call.responseDto}` : call.responseDto}`
      lines.push(`- ${call.operation}: ${call.method} ${call.path}${esb}${returns}`)
    }
  }
  if (spec.dtos.length > 0) {
    lines.push("", "## Anti-corruption renames")
    for (const dto of spec.dtos) {
      lines.push(`- ${dto.legacyName} → ${dto.domainName}`)
      for (const field of dto.fields) {
        lines.push(`  - ${field.legacyName} → ${field.domainName} (${field.type})`)
      }
    }
  }
  if (spec.sessionState.length > 0) {
    lines.push("", "## Session state", ...spec.sessionState.map((item) => `- ${item}`))
  }
  if (spec.openQuestions.length > 0) {
    lines.push("", "## Open questions", ...spec.openQuestions.map((item) => `- ${item}`))
  }
  return lines.join("\n") + "\n"
}
