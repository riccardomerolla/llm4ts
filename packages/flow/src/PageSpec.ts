import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PlanParseError } from "./FlowError.ts"

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

export class PageApiCall extends Schema.Class<PageApiCall>("PageApiCall")({
  /** Domain operation id, e.g. `listAccounts` — becomes the OpenAPI operationId. */
  operation: Schema.String,
  method: Schema.String,
  path: Schema.String,
  /** The ESB service behind the legacy endpoint, when known. */
  esbService: Schema.optionalKey(Schema.String),
  request: Schema.Array(FieldMapping).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyMappings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyMappings))
  ),
  response: Schema.Array(FieldMapping).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyMappings)),
    Schema.withDecodingDefaultKey(Effect.succeed(emptyMappings))
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
export const openApiFor = (spec: PageSpec): string => {
  const byPath = new Map<string, Array<PageApiCall>>()
  for (const call of spec.apiCalls) {
    const bucket = byPath.get(call.path) ?? []
    bucket.push(call)
    byPath.set(call.path, bucket)
  }
  const paths = [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right))
  const lines: Array<string> = [
    "openapi: 3.0.3",
    "info:",
    `  title: ${yamlText(`${spec.title} service contract`)}`,
    `  description: ${yamlText(`Anti-corruption contract for page ${spec.page} (${spec.route})`)}`,
    "  version: 0.1.0",
    "paths:"
  ]
  if (paths.length === 0) {
    lines[lines.length - 1] = "paths: {}"
  }
  for (const [path, calls] of paths) {
    lines.push(`  ${path}:`)
    for (const call of [...calls].sort((a, b) => a.method.localeCompare(b.method))) {
      const method = call.method.toLowerCase()
      lines.push(`    ${method}:`)
      lines.push(`      operationId: ${call.operation}`)
      if (call.esbService !== undefined) {
        lines.push(`      description: ${yamlText(`backed by ESB service ${call.esbService}`)}`)
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
      lines.push(
        `                $ref: "#/components/schemas/${schemaName(call.operation, "Response")}"`
      )
    }
  }
  lines.push("components:")
  lines.push("  schemas:")
  const schemaCalls = [...spec.apiCalls].sort((a, b) => a.operation.localeCompare(b.operation))
  let wroteSchema = false
  for (const call of schemaCalls) {
    for (const [side, fields] of [
      ["Request", call.request],
      ["Response", call.response]
    ] as const) {
      if (side === "Request" && (fields.length === 0 || call.method.toLowerCase() === "get")) {
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
      lines.push(`- ${call.operation}: ${call.method} ${call.path}${esb}`)
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
