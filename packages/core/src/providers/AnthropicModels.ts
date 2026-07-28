import * as Schema from "effect/Schema"
import { JsonSchema } from "../Models.ts"

export class AnthropicMessage extends Schema.Class<AnthropicMessage>("AnthropicMessage")({
  role: Schema.String,
  content: Schema.String
}) {}

export class AnthropicRequest extends Schema.Class<AnthropicRequest>("AnthropicRequest")({
  model: Schema.String,
  max_tokens: Schema.Int,
  messages: Schema.Array(AnthropicMessage),
  temperature: Schema.optionalKey(Schema.Number),
  system: Schema.optionalKey(Schema.String),
  stream: Schema.optionalKey(Schema.Boolean)
}) {}

export class AnthropicContentBlock extends Schema.Class<AnthropicContentBlock>(
  "AnthropicContentBlock"
)({
  type: Schema.String,
  text: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class AnthropicUsage extends Schema.Class<AnthropicUsage>("AnthropicUsage")({
  input_tokens: Schema.optionalKey(Schema.Int),
  output_tokens: Schema.optionalKey(Schema.Int)
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
  system: Schema.optionalKey(Schema.String)
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

export class AnthropicStreamChunk extends Schema.Class<AnthropicStreamChunk>(
  "AnthropicStreamChunk"
)({
  type: Schema.String,
  delta: Schema.optionalKey(AnthropicStreamChunkDelta)
}) {}
