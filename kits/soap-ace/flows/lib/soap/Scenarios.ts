import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import { elementByName, operationByName, type WsdlCatalog } from "./Catalog.ts"
import type { OperationClass } from "./Classification.ts"
import { readIfPresent } from "./Discover.ts"
import { type Issue, skeletonYaml, validateInstance } from "./Instance.ts"
import { renderRequestFile, samplePaths, toSampleName } from "./Samples.ts"
import type { YamlValue } from "./Yaml.ts"

// Scenario sets: for one operation the reasoning seat proposes a handful of
// request bodies that together exercise it — the happy path, an empty
// result, a pagination boundary, a business fault, a schema edge. The model
// only drafts; each body is validated against the XSD and written as an
// ordinary request file (with its problems listed at the top), so the user
// reviews and edits before anything is called. Existing files are kept.

export class ProposedScenario extends Schema.Class<ProposedScenario>("ProposedScenario")({
  name: Schema.String,
  purpose: Schema.String,
  body: Schema.Json
}) {}

export class ScenarioSet extends Schema.Class<ScenarioSet>("ScenarioSet")({
  scenarios: Schema.Array(ProposedScenario)
}) {}

const scenarioJsonSchema: JsonSchema = {
  type: "object",
  required: ["scenarios"],
  properties: {
    scenarios: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "purpose", "body"],
        properties: {
          name: { type: "string", description: "kebab-case, e.g. happy-path" },
          purpose: { type: "string", description: "what the scenario exercises, one sentence" },
          body: { type: "object", description: "the request body, shaped like the skeleton" }
        }
      }
    }
  }
}

/** JSON from a model → request values: every leaf a string, as XML text is. */
export const toYamlValue = (value: Schema.Json): YamlValue => {
  if (value === null) return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(toYamlValue)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toYamlValue(item)]))
}

export const scenarioPrompt = (options: {
  readonly catalog: WsdlCatalog
  readonly operation: string
  readonly operationClass: OperationClass
  readonly seeds: ReadonlyMap<string, string>
}): string | undefined => {
  const operation = operationByName(options.catalog, options.operation)
  const input =
    operation === undefined ? undefined : elementByName(options.catalog, operation.input)
  if (operation === undefined || input === undefined) return undefined
  const output =
    operation.output === undefined ? undefined : elementByName(options.catalog, operation.output)
  const seeds = [...options.seeds].map(([field, value]) => `- ${field}: ${value}`)
  return [
    `You are preparing sample requests to explore the SOAP operation ${operation.name} of a bank's backend,`,
    "before an equivalent REST API is designed. Propose 3 to 6 scenarios that together show how it really",
    "behaves. Cover, where the operation allows it: the happy path; an empty or not-found result; a",
    "pagination boundary; one business error (an esito KO code or a SOAP fault); one schema edge (maximum",
    "lengths, optional fields left out, optional fields all present).",
    "",
    `Operation: ${operation.name} (${options.operationClass})`,
    ...(operation.documentation === undefined ? [] : [`Documentation: ${operation.documentation}`]),
    `Faults: ${operation.faults.map((fault) => fault.name).join(", ") || "none declared"}`,
    "",
    "The request body, as YAML with type notes (required fields filled, optional ones commented):",
    "```yaml",
    ...skeletonYaml(options.catalog, input, 0),
    "```",
    ...(output === undefined
      ? []
      : [
          "",
          "The response body shape:",
          "```yaml",
          ...skeletonYaml(options.catalog, output, 0, { maxDepth: 3 }),
          "```"
        ]),
    "",
    "Rules:",
    "- Use only synthetic data. Never invent a real person's name, tax code, or account.",
    "- Reuse these identifiers seen in earlier samples wherever an identifier is needed; they are masked",
    "  test values the service is likely to know:",
    ...(seeds.length === 0
      ? ["  (none yet: use the examples in the skeleton)"]
      : seeds.map((seed) => `  ${seed}`)),
    "- Every value is a string. Respect the type notes (patterns, lengths, enumerations, digits).",
    "- Omit optional fields you do not need; never add fields that are not in the skeleton.",
    "- Names are kebab-case and unique; the purpose says what the scenario should reveal.",
    "",
    'Reply with JSON: {"scenarios": [{"name": "...", "purpose": "...", "body": {...}}]}.'
  ].join("\n")
}

export interface WrittenScenario {
  readonly name: string
  readonly path: string
  readonly issues: ReadonlyArray<Issue>
  readonly kept: boolean
}

export const proposeScenarios = (options: {
  readonly reasoning: LlmServiceShape
  readonly workspace: WorkspaceShape
  readonly catalog: WsdlCatalog
  readonly service: string
  readonly operation: string
  readonly operationClass: OperationClass
  readonly seeds: ReadonlyMap<string, string>
}): Effect.Effect<ReadonlyArray<WrittenScenario>, LlmError | WorkspaceError> =>
  Effect.gen(function* () {
    const prompt = scenarioPrompt(options)
    const operation = operationByName(options.catalog, options.operation)
    const input =
      operation === undefined ? undefined : elementByName(options.catalog, operation.input)
    if (prompt === undefined || input === undefined) return []
    const proposal = yield* options.reasoning.executeStructured(
      prompt,
      ScenarioSet,
      scenarioJsonSchema
    )
    const written: Array<WrittenScenario> = []
    const names = new Set<string>()
    for (const scenario of proposal.scenarios) {
      let name = toSampleName(scenario.name)
      for (let suffix = 2; names.has(name); suffix++)
        name = `${toSampleName(scenario.name).slice(0, 58)}-${suffix}`
      names.add(name)
      const paths = samplePaths(options.service, options.operation, name)
      const exists =
        (yield* readIfPresent(options.workspace, paths.yaml)) !== undefined ||
        (yield* readIfPresent(options.workspace, paths.xml)) !== undefined
      const body = toYamlValue(scenario.body)
      const issues = validateInstance(options.catalog, input, body)
      if (exists) {
        written.push({ name, path: paths.yaml, issues, kept: true })
        continue
      }
      yield* options.workspace.write(
        paths.yaml,
        renderRequestFile({
          catalog: options.catalog,
          operation: options.operation,
          purpose: scenario.purpose,
          body,
          issues
        })
      )
      written.push({ name, path: paths.yaml, issues, kept: false })
    }
    return written
  })
