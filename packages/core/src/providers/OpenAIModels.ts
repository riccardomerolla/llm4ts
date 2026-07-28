import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { JsonSchema } from "../Models.ts"

export class OpenAIJsonSchemaSpec extends Schema.Class<OpenAIJsonSchemaSpec>(
  "OpenAIJsonSchemaSpec"
)({
  name: Schema.String,
  schema: JsonSchema
}) {}

export class OpenAIResponseFormat extends Schema.Class<OpenAIResponseFormat>(
  "OpenAIResponseFormat"
)({
  type: Schema.String,
  json_schema: Schema.optionalKey(OpenAIJsonSchemaSpec)
}) {}

export class OpenAIChatMessage extends Schema.Class<OpenAIChatMessage>("OpenAIChatMessage")({
  role: Schema.String,
  content: Schema.String
}) {}

export class OpenAIChatCompletionRequest extends Schema.Class<OpenAIChatCompletionRequest>(
  "OpenAIChatCompletionRequest"
)({
  model: Schema.String,
  messages: Schema.Array(OpenAIChatMessage),
  temperature: Schema.optionalKey(Schema.Number),
  max_tokens: Schema.optionalKey(Schema.Int),
  max_completion_tokens: Schema.optionalKey(Schema.Int),
  stream: Schema.optionalKey(Schema.Boolean),
  response_format: Schema.optionalKey(OpenAIResponseFormat)
}) {}

export class OpenAITokenUsage extends Schema.Class<OpenAITokenUsage>("OpenAITokenUsage")({
  prompt_tokens: Schema.optionalKey(Schema.Int),
  completion_tokens: Schema.optionalKey(Schema.Int),
  total_tokens: Schema.optionalKey(Schema.Int)
}) {}

export class OpenAIChatResponseMessage extends Schema.Class<OpenAIChatResponseMessage>(
  "OpenAIChatResponseMessage"
)({
  role: Schema.String,
  content: Schema.NullOr(Schema.String)
}) {}

export class OpenAIChatChoice extends Schema.Class<OpenAIChatChoice>("OpenAIChatChoice")({
  index: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(0))),
  message: Schema.optionalKey(OpenAIChatResponseMessage),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class OpenAIChatCompletionResponse extends Schema.Class<OpenAIChatCompletionResponse>(
  "OpenAIChatCompletionResponse"
)({
  id: Schema.optionalKey(Schema.String),
  choices: Schema.Array(OpenAIChatChoice),
  usage: Schema.optionalKey(OpenAITokenUsage),
  model: Schema.optionalKey(Schema.String)
}) {}

export class OpenAIFunction extends Schema.Class<OpenAIFunction>("OpenAIFunction")({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonSchema
}) {}

export class OpenAITool extends Schema.Class<OpenAITool>("OpenAITool")({
  type: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("function"))),
  function: OpenAIFunction
}) {}

export class OpenAIToolCallFunction extends Schema.Class<OpenAIToolCallFunction>(
  "OpenAIToolCallFunction"
)({
  name: Schema.String,
  arguments: Schema.String
}) {}

export class OpenAIToolCall extends Schema.Class<OpenAIToolCall>("OpenAIToolCall")({
  id: Schema.String,
  type: Schema.String,
  function: OpenAIToolCallFunction
}) {}

const noToolCalls: ReadonlyArray<OpenAIToolCall> = Object.freeze([])

export class OpenAIChatMessageWithTools extends Schema.Class<OpenAIChatMessageWithTools>(
  "OpenAIChatMessageWithTools"
)({
  role: Schema.String,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool_calls: Schema.Array(OpenAIToolCall).pipe(
    Schema.withConstructorDefault(Effect.succeed(noToolCalls))
  )
}) {}

export class OpenAIChatChoiceWithTools extends Schema.Class<OpenAIChatChoiceWithTools>(
  "OpenAIChatChoiceWithTools"
)({
  index: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(0))),
  message: Schema.optionalKey(OpenAIChatMessageWithTools),
  finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class OpenAIChatCompletionResponseWithTools extends Schema.Class<OpenAIChatCompletionResponseWithTools>(
  "OpenAIChatCompletionResponseWithTools"
)({
  id: Schema.optionalKey(Schema.String),
  choices: Schema.Array(OpenAIChatChoiceWithTools),
  usage: Schema.optionalKey(OpenAITokenUsage),
  model: Schema.optionalKey(Schema.String)
}) {}

export class OpenAIChatCompletionRequestWithTools extends Schema.Class<OpenAIChatCompletionRequestWithTools>(
  "OpenAIChatCompletionRequestWithTools"
)({
  model: Schema.String,
  messages: Schema.Array(OpenAIChatMessage),
  tools: Schema.Array(OpenAITool),
  temperature: Schema.optionalKey(Schema.Number),
  max_tokens: Schema.optionalKey(Schema.Int),
  stream: Schema.optionalKey(Schema.Boolean)
}) {}

export class OpenAIChatChunkDelta extends Schema.Class<OpenAIChatChunkDelta>(
  "OpenAIChatChunkDelta"
)({
  role: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class OpenAIChatChunkChoice extends Schema.Class<OpenAIChatChunkChoice>(
  "OpenAIChatChunkChoice"
)({
  index: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(0))),
  delta: Schema.optionalKey(OpenAIChatChunkDelta),
  finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

const noChunkChoices: ReadonlyArray<OpenAIChatChunkChoice> = Object.freeze([])

export class OpenAIChatChunk extends Schema.Class<OpenAIChatChunk>("OpenAIChatChunk")({
  id: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  choices: Schema.Array(OpenAIChatChunkChoice).pipe(
    Schema.withConstructorDefault(Effect.succeed(noChunkChoices))
  )
}) {}
