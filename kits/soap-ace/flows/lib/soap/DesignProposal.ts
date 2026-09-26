import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { OperationAnalysis } from "./Analysis.ts"
import { ComplexTypeDef, localName, type WsdlCatalog } from "./Catalog.ts"
import { effectiveClass, type OperationsFile } from "./Classification.ts"
import { ApiDesign, type DesignIssue } from "./Design.ts"
import type { MappedField, ServiceMapping } from "./Mapping.ts"

// The reasoning seat drafts the REST design; it never has the last word.
// The prompt carries the style guide as hard rules, the confirmed classes,
// the 1:1 mapping (the only paths a source may cite), the named XSD types a
// model may bind to, and the analysis evidence. The reply is decoded into
// `ApiDesign` and then goes through `checkDesign` like a hand-written one;
// `revise` feeds the check's findings back for another draft.

const property = { type: "object", required: ["name", "type", "required"] }
const designJsonSchema: JsonSchema = {
  type: "object",
  required: ["version", "title", "basePath", "endpoints", "models", "excluded"],
  properties: {
    version: { const: 1 },
    title: { type: "string" },
    basePath: { type: "string", description: "/v1" },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        required: [
          "method",
          "path",
          "operationId",
          "summary",
          "sources",
          "parameters",
          "responses",
          "errors",
          "evidence"
        ],
        properties: {
          method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string" },
          operationId: { type: "string" },
          summary: { type: "string" },
          sources: { type: "array", items: { type: "string" } },
          parameters: { type: "array", items: property },
          requestBody: { type: "object", required: ["model", "required"] },
          responses: {
            type: "array",
            items: { type: "object", required: ["status", "description"] }
          },
          errors: {
            type: "array",
            items: { type: "object", required: ["status", "code", "title", "from"] }
          },
          evidence: { type: "array", items: { type: "string" } }
        }
      }
    },
    models: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "properties"],
        properties: { properties: { type: "array", items: property } }
      }
    },
    excluded: { type: "array", items: { type: "object", required: ["operation", "reason"] } },
    notes: { type: "array", items: { type: "string" } }
  }
}

const fieldLine = (field: MappedField): string =>
  `    ${field.xsd}: ${field.jsonType}${field.format === undefined ? "" : `(${field.format})`} ${field.xsdType}${field.required ? "" : " optional"}${field.enumeration === undefined ? "" : ` enum ${field.enumeration.join("|")}`}`

const analysisLines = (analysis: OperationAnalysis): ReadonlyArray<string> => [
  `  ${analysis.operation}: ${analysis.exchanges} samples`,
  ...analysis.observations.map((line) => `    - ${line}`),
  ...analysis.outcomes.map(
    (outcome) =>
      `    - outcome ${outcome.code}${outcome.description === undefined ? "" : ` "${outcome.description}"`} ×${outcome.count}`
  ),
  ...analysis.faults.map(
    (fault) => `    - fault ${fault.detailElement ?? fault.code}: ${fault.reason} ×${fault.count}`
  ),
  ...(analysis.pagination === undefined
    ? []
    : [
        `    - pagination ${analysis.pagination.style}: request ${analysis.pagination.requestFields.join(", ")}; response ${analysis.pagination.responseFields.join(", ")}; ${analysis.pagination.observed}`
      ]),
  ...analysis.fields
    .filter(
      (field) =>
        field.distinct > 0 &&
        field.distinct <= 8 &&
        field.values.every((entry) => entry.value.length <= 20)
    )
    .map(
      (field) =>
        `    - values of ${field.path}: ${field.values.map((entry) => entry.value).join(", ")}`
    )
]

const exampleDesign = {
  version: 1,
  title: "Example",
  basePath: "/v1",
  endpoints: [
    {
      method: "GET",
      path: "/orders/{orderId}",
      operationId: "getOrder",
      summary: "One order",
      sources: ["leggiOrdine"],
      parameters: [
        { name: "orderId", in: "path", required: true, type: "string", source: "idOrdine" }
      ],
      responses: [{ status: 200, description: "The order", model: "Order", source: "" }],
      errors: [{ status: 404, code: "order-not-found", title: "No such order", from: ["KO04"] }],
      evidence: ["analysis/leggiOrdine: KO04 inside a 200 when the order does not exist"]
    }
  ],
  models: [
    {
      name: "Order",
      sourceType: "leggiOrdineResponse",
      properties: [
        { name: "id", type: "string", required: true, source: "ordine.id" },
        {
          name: "status",
          type: "string",
          required: true,
          source: "ordine.stato",
          enum: ["OPEN", "SHIPPED"],
          enumMap: { APERTO: "OPEN", SPEDITO: "SHIPPED" }
        },
        { name: "total", type: "object", ref: "Amount", required: true, source: "ordine.totale" }
      ]
    },
    {
      name: "Amount",
      sourceType: "ImportoType",
      properties: [
        { name: "amount", type: "string", format: "decimal", required: true, source: "valore" },
        { name: "currency", type: "string", required: true, source: "divisa" }
      ]
    }
  ],
  excluded: []
}

export const designPrompt = (options: {
  readonly catalog: WsdlCatalog
  readonly operations: OperationsFile | undefined
  readonly mapping: ServiceMapping
  readonly analyses: ReadonlyArray<OperationAnalysis>
  readonly style: string
}): string => {
  const { catalog } = options
  const namedTypes = catalog.types
    .filter((type) => !type.anonymous && type instanceof ComplexTypeDef)
    .map((type) => localName(type.name))
  return [
    "You design the REST API that an IBM ACE integration will expose in front of a bank's SOAP service.",
    "Design resources, not a SOAP facade: group operations into resources, map SOAP faults and business",
    "outcome codes to HTTP statuses and problem codes, flatten SOAP wrappers, drop the esito envelope, and",
    "translate Italian field names to English camelCase. Every design element must be traceable to the SOAP",
    "service, and every decision the samples inform must cite them in `evidence`.",
    "",
    "## Style guide (hard rules)",
    "",
    options.style.trim(),
    "",
    "## Operations (confirmed class: read ones may be GET; mutating ones never are)",
    "",
    ...catalog.operations.map(
      (operation) =>
        `- ${operation.name} [${effectiveClass(options.operations, operation.name)}]${operation.documentation === undefined ? "" : `: ${operation.documentation}`}`
    ),
    "",
    "## 1:1 mapping: the only XSD paths a source may cite",
    "",
    ...options.mapping.operations.flatMap((operation) => [
      `${operation.operation}`,
      `  request ${operation.request}:`,
      ...operation.requestFields.map(fieldLine),
      ...(operation.response === undefined
        ? []
        : [`  response ${operation.response}:`, ...operation.responseFields.map(fieldLine)])
    ]),
    "",
    `Named XSD types a model may bind to (besides the request/response elements above): ${namedTypes.join(", ")}`,
    "",
    "## Evidence from masked samples",
    "",
    ...(options.analyses.length === 0
      ? ["(no samples analysed)"]
      : options.analyses.flatMap(analysisLines)),
    "",
    "## Format",
    "",
    "- Each model binds to one XSD element or named type (`sourceType`); each property's `source` is an XSD",
    "  path relative to it (`saldo.valore`), or `derivation` explains how it is computed.",
    "- Each parameter's `source` is a path in the request of the endpoint's first SOAP operation.",
    '- Each response names its `model` and the `source` path in the SOAP response it comes from (`""` for the',
    "  whole response); collections set `list: true` (and `paged: true` when the service pages).",
    "- An `enumMap` must cover every declared SOAP value and every value the samples showed.",
    "- `errors[].from` lists the outcome codes (KO17) and fault detail elements (ServizioFault) it maps; map",
    "  every one the evidence shows.",
    "- Every SOAP operation appears in some endpoint's `sources` or in `excluded` with a reason.",
    "",
    "Example of the shape (not of this service):",
    "```json",
    JSON.stringify(exampleDesign, null, 2),
    "```",
    "",
    "Reply with the ApiDesign JSON only."
  ].join("\n")
}

export const proposeDesign = (
  reasoning: LlmServiceShape,
  options: Parameters<typeof designPrompt>[0]
): Effect.Effect<ApiDesign, LlmError> =>
  reasoning.executeStructured(designPrompt(options), ApiDesign, designJsonSchema)

export const reviseDesign = (
  reasoning: LlmServiceShape,
  options: Parameters<typeof designPrompt>[0] & {
    readonly current: ApiDesign
    readonly issues: ReadonlyArray<DesignIssue>
  }
): Effect.Effect<ApiDesign, LlmError> =>
  reasoning.executeStructured(
    [
      designPrompt(options),
      "",
      "## Current draft",
      "",
      "```json",
      JSON.stringify(Schema.encodeSync(ApiDesign)(options.current), null, 2),
      "```",
      "",
      "## The design check found",
      "",
      ...options.issues.map((issue) => `- ${issue.severity} ${issue.where}: ${issue.detail}`),
      "",
      "Fix every error and every warning you can; keep everything else as it is. Reply with the full ApiDesign JSON."
    ].join("\n"),
    ApiDesign,
    designJsonSchema
  )
