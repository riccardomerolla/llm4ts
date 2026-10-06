import * as Schema from "effect/Schema"
import { JsonSchema } from "../Models.ts"

/** A prompt-cache breakpoint (ADR 0029): the prefix up to this block is cached. */
export class AnthropicCacheControl extends Schema.Class<AnthropicCacheControl>(
  "AnthropicCacheControl"
)({
  type: Schema.Literal("ephemeral")
}) {}

export class AnthropicTextBlock extends Schema.Class<AnthropicTextBlock>("AnthropicTextBlock")({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache_control: Schema.optionalKey(AnthropicCacheControl)
}) {}

export class AnthropicMessage extends Schema.Class<AnthropicMessage>("AnthropicMessage")({
  role: Schema.String,
  /** Plain text, or text blocks when one carries a cache marker. */
  content: Schema.Union([Schema.String, Schema.Array(AnthropicTextBlock)])
}) {}

export class AnthropicOutputConfig extends Schema.Class<AnthropicOutputConfig>(
  "AnthropicOutputConfig"
)({
  effort: Schema.Literals(["low", "medium", "high", "max"])
}) {}

export class AnthropicRequest extends Schema.Class<AnthropicRequest>("AnthropicRequest")({
  model: Schema.String,
  max_tokens: Schema.Int,
  messages: Schema.Array(AnthropicMessage),
  temperature: Schema.optionalKey(Schema.Number),
  system: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(AnthropicTextBlock)])),
  stream: Schema.optionalKey(Schema.Boolean),
  output_config: Schema.optionalKey(AnthropicOutputConfig)
}) {}

export class AnthropicContentBlock extends Schema.Class<AnthropicContentBlock>(
  "AnthropicContentBlock"
)({
  type: Schema.String,
  text: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class AnthropicUsage extends Schema.Class<AnthropicUsage>("AnthropicUsage")({
  input_tokens: Schema.optionalKey(Schema.Int),
  output_tokens: Schema.optionalKey(Schema.Int),
  cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Int))
}) {}

export class AnthropicResponse extends Schema.Class<AnthropicResponse>("AnthropicResponse")({
  id: Schema.optionalKey(Schema.String),
  content: Schema.Array(AnthropicContentBlock),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(AnthropicUsage),
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class AnthropicToolInputSchema extends Schema.Class<AnthropicToolInputSchema>(
  "AnthropicToolInputSchema"
)({
  type: Schema.String,
  properties: JsonSchema,
  required: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

export class AnthropicTool extends Schema.Class<AnthropicTool>("AnthropicTool")({
  name: Schema.String,
  description: Schema.String,
  input_schema: AnthropicToolInputSchema
}) {}

export class AnthropicContentBlockFull extends Schema.Class<AnthropicContentBlockFull>(
  "AnthropicContentBlockFull"
)({
  type: Schema.String,
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Json)
}) {}

export class AnthropicRequestWithTools extends Schema.Class<AnthropicRequestWithTools>(
  "AnthropicRequestWithTools"
)({
  model: Schema.String,
  max_tokens: Schema.Int,
  messages: Schema.Array(AnthropicMessage),
  tools: Schema.Array(AnthropicTool),
  temperature: Schema.optionalKey(Schema.Number),
  system: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(AnthropicTextBlock)])),
  output_config: Schema.optionalKey(AnthropicOutputConfig)
}) {}

export class AnthropicResponseWithTools extends Schema.Class<AnthropicResponseWithTools>(
  "AnthropicResponseWithTools"
)({
  id: Schema.optionalKey(Schema.String),
  content: Schema.Array(AnthropicContentBlockFull),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(AnthropicUsage),
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class AnthropicStreamChunkDelta extends Schema.Class<AnthropicStreamChunkDelta>(
  "AnthropicStreamChunkDelta"
)({
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

/** The `message_start` event's message: where input and cache usage arrive. */
export class AnthropicStreamMessage extends Schema.Class<AnthropicStreamMessage>(
  "AnthropicStreamMessage"
)({
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(AnthropicUsage)
}) {}

export class AnthropicStreamChunk extends Schema.Class<AnthropicStreamChunk>(
  "AnthropicStreamChunk"
)({
  type: Schema.String,
  delta: Schema.optionalKey(AnthropicStreamChunkDelta),
  message: Schema.optionalKey(AnthropicStreamMessage),
  /** On `message_delta`: the output tokens so far. */
  usage: Schema.optionalKey(AnthropicUsage)
}) {}
