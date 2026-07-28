import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capability as CapabilitySchema, type Capability } from "../Capability.ts"
import { ToolDefinition, type JsonSchema, type LlmProvider } from "../Models.ts"
import {
  isJsonRecord,
  jsonArray,
  jsonField,
  jsonStringField,
  type JsonValue
} from "../providers/CliSupport.ts"

export class InvalidToolSchema extends Schema.TaggedErrorClass<InvalidToolSchema>()(
  "InvalidSchema",
  {
    message: Schema.String
  }
) {}

export class InvalidToolParameters extends Schema.TaggedErrorClass<InvalidToolParameters>()(
  "InvalidParameters",
  {
    message: Schema.String
  }
) {}

export class DuplicateToolName extends Schema.TaggedErrorClass<DuplicateToolName>()(
  "DuplicateToolName",
  {
    name: Schema.String
  }
) {
  get message(): string {
    return `Tool already registered: ${this.name}`
  }
}

export class ToolSandboxViolation extends Schema.TaggedErrorClass<ToolSandboxViolation>()(
  "SandboxViolation",
  {
    message: Schema.String
  }
) {}

export class ToolExecutionFailed extends Schema.TaggedErrorClass<ToolExecutionFailed>()(
  "ExecutionFailed",
  {
    message: Schema.String
  }
) {}

export class ToolSchemaGenerationFailed extends Schema.TaggedErrorClass<ToolSchemaGenerationFailed>()(
  "SchemaGenerationFailed",
  {
    message: Schema.String
  }
) {}

export const ToolExecutionError = Schema.Union([
  InvalidToolSchema,
  InvalidToolParameters,
  DuplicateToolName,
  ToolSandboxViolation,
  ToolExecutionFailed,
  ToolSchemaGenerationFailed
])
export type ToolExecutionError = typeof ToolExecutionError.Type

export const ToolSandbox = Schema.Literals([
  "WorkspaceReadWrite",
  "WorkspaceReadOnly",
  "Unrestricted"
])
export type ToolSandbox = typeof ToolSandbox.Type

export class ToolDescriptor extends Schema.Class<ToolDescriptor>("ToolDescriptor")({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Json),
  tags: Schema.ReadonlySet(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(new Set<string>()))
  ),
  sandbox: ToolSandbox.pipe(Schema.withConstructorDefault(Effect.succeed("WorkspaceReadWrite"))),
  requires: Schema.Array(CapabilitySchema).pipe(
    Schema.withConstructorDefault(Effect.succeed(Object.freeze([])))
  )
}) {}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly execute: (parameters: JsonValue) => Effect.Effect<JsonValue, ToolExecutionError>
  readonly tags: ReadonlySet<string>
  readonly sandbox: ToolSandbox
  readonly requires: ReadonlyArray<Capability>
}

export interface ToolOptions {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly execute: Tool["execute"]
  readonly tags?: Iterable<string>
  readonly sandbox?: ToolSandbox
  readonly requires?: ReadonlyArray<Capability>
}

export const makeTool = (options: ToolOptions): Tool => ({
  name: options.name,
  description: options.description,
  parameters: options.parameters,
  execute: options.execute,
  tags: new Set(options.tags ?? []),
  sandbox: options.sandbox ?? "WorkspaceReadWrite",
  requires: options.requires ?? []
})

export const toolDefinition = (tool: Tool): ToolDefinition =>
  ToolDefinition.make({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  })

const splitParameters = (raw: string): ReadonlyArray<string> => {
  const parameters: Array<string> = []
  let start = 0
  let depth = 0
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw.charAt(index)
    if (character === "[" || character === "<" || character === "(") {
      depth += 1
    } else if (character === "]" || character === ">" || character === ")") {
      depth -= 1
    } else if (character === "," && depth === 0) {
      parameters.push(raw.slice(start, index).trim())
      start = index + 1
    }
  }
  const last = raw.slice(start).trim()
  return last.length === 0 ? parameters : [...parameters, last]
}

interface ParsedParameter {
  readonly name: string
  readonly type: string
  readonly required: boolean
}

const parseParameter = (raw: string): ParsedParameter | undefined => {
  const match = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+?)(?:\s*=\s*.+)?$/.exec(raw)
  const name = match?.[1]
  const type = match?.[3]?.trim()
  if (name === undefined || type === undefined) {
    return undefined
  }
  const optional = match?.[2] === "?" || raw.includes("=") || /^(?:Option|Optional)[[<]/.test(type)
  return {
    name,
    type,
    required: !optional
  }
}

const genericInner = (type: string, names: ReadonlyArray<string>): string | undefined => {
  for (const name of names) {
    const squarePrefix = `${name}[`
    const anglePrefix = `${name}<`
    if (type.startsWith(squarePrefix) && type.endsWith("]")) {
      return type.slice(squarePrefix.length, -1).trim()
    }
    if (type.startsWith(anglePrefix) && type.endsWith(">")) {
      return type.slice(anglePrefix.length, -1).trim()
    }
  }
  return undefined
}

const schemaForType = (rawType: string): JsonValue => {
  const type = rawType.trim()
  switch (type) {
    case "String":
    case "string":
      return { type: "string" }
    case "Boolean":
    case "boolean":
      return { type: "boolean" }
    case "Int":
    case "Long":
    case "Short":
    case "Byte":
    case "BigInt":
    case "int":
    case "integer":
      return { type: "integer" }
    case "Double":
    case "Float":
    case "BigDecimal":
    case "number":
      return { type: "number" }
  }

  const optional = genericInner(type, ["Option", "Optional"])
  if (optional !== undefined) {
    return schemaForType(optional)
  }
  const array = genericInner(type, ["List", "Seq", "Vector", "Set", "Array", "ReadonlyArray"])
  if (array !== undefined) {
    return {
      type: "array",
      items: schemaForType(array)
    }
  }
  const map = genericInner(type, ["Map", "Record"])
  if (map !== undefined) {
    const parts = splitParameters(map)
    return {
      type: "object",
      additionalProperties: schemaForType(parts.at(-1) ?? "object")
    }
  }
  return { type: "object" }
}

export const schemaFromMethodSignature = (
  signature: string
): Effect.Effect<JsonSchema, ToolSchemaGenerationFailed> => {
  const parametersText = signature.match(
    /(?:def|function)?\s*[A-Za-z_$][\w$]*\s*\((.*)\)\s*(?::.*)?$/
  )?.[1]
  if (parametersText === undefined) {
    return Effect.fail(
      ToolSchemaGenerationFailed.make({
        message: "Unsupported signature. Expected a method declaration or definition"
      })
    )
  }
  const parameters = splitParameters(parametersText).map(parseParameter)
  if (parameters.some((parameter) => parameter === undefined)) {
    return Effect.fail(
      ToolSchemaGenerationFailed.make({
        message: "Failed to parse one or more method parameters"
      })
    )
  }

  const properties: Record<string, JsonValue> = {}
  const required: Array<string> = []
  for (const parameter of parameters) {
    if (parameter !== undefined) {
      properties[parameter.name] = schemaForType(parameter.type)
      if (parameter.required) {
        required.push(parameter.name)
      }
    }
  }
  return Effect.succeed({
    type: "object",
    properties,
    required,
    additionalProperties: false
  })
}

export const toolFromMethodSignature = Effect.fn("@llm4ts/core/tools/Tool.fromMethodSignature")(
  function* (
    options: Omit<ToolOptions, "parameters"> & {
      readonly signature: string
    }
  ) {
    const parameters = yield* schemaFromMethodSignature(options.signature)
    return makeTool({
      ...options,
      parameters
    })
  }
)

const valueMatchesType = (value: JsonValue, expected: string): boolean => {
  switch (expected) {
    case "string":
      return typeof value === "string"
    case "boolean":
      return typeof value === "boolean"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "number":
      return typeof value === "number"
    case "array":
      return Array.isArray(value)
    case "object":
      return isJsonRecord(value)
    default:
      return true
  }
}

export const validateToolParameters = Effect.fn("@llm4ts/core/tools/Tool.validateParameters")(
  function* (
    schema: JsonSchema,
    parameters: JsonValue
  ): Effect.fn.Return<void, ToolExecutionError> {
    if (!isJsonRecord(schema)) {
      return yield* InvalidToolParameters.make({
        message: "Tool schema must be a JSON object"
      })
    }
    if (!isJsonRecord(parameters)) {
      return yield* InvalidToolParameters.make({
        message: "Tool arguments must be a JSON object"
      })
    }

    const required = jsonArray(jsonField(schema, "required")).flatMap((value) =>
      typeof value === "string" ? [value] : []
    )
    const missing = required.filter((name) => parameters[name] === undefined).sort()
    if (missing.length > 0) {
      return yield* InvalidToolParameters.make({
        message: `Missing required parameters: ${missing.join(", ")}`
      })
    }

    const properties = jsonField(schema, "properties")
    for (const [name, value] of Object.entries(parameters)) {
      const property = jsonField(properties, name)
      if (property !== undefined) {
        const expected = jsonStringField(property, "type") ?? "object"
        if (!valueMatchesType(value, expected)) {
          return yield* InvalidToolParameters.make({
            message: `Invalid type for '${name}'. Expected: ${expected}`
          })
        }
      }
    }
  }
)

export const toolsToOpenAI = (tools: ReadonlyArray<Tool>): JsonValue =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))

export const toolsToAnthropic = (tools: ReadonlyArray<Tool>): JsonValue =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }))

export const toolsToGemini = (tools: ReadonlyArray<Tool>): JsonValue => ({
  functionDeclarations: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }))
})

export const toolsToProviderFormat = (
  provider: LlmProvider,
  tools: ReadonlyArray<Tool>
): JsonValue => {
  switch (provider) {
    case "OpenAI":
      return toolsToOpenAI(tools)
    case "Anthropic":
      return toolsToAnthropic(tools)
    case "GeminiApi":
      return toolsToGemini(tools)
    default:
      return []
  }
}
