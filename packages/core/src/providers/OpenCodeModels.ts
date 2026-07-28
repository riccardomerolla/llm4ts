import * as Schema from "effect/Schema"
import { JsonSchema } from "../Models.ts"

export class OpenCodeMessage extends Schema.Class<OpenCodeMessage>("OpenCodeMessage")({
  role: Schema.String,
  content: Schema.String
}) {}

export class OpenCodeJsonSchemaSpec extends Schema.Class<OpenCodeJsonSchemaSpec>(
  "OpenCodeJsonSchemaSpec"
)({
  name: Schema.String,
  schema: JsonSchema
}) {}

export class OpenCodeResponseFormat extends Schema.Class<OpenCodeResponseFormat>(
  "OpenCodeResponseFormat"
)({
  type: Schema.String,
  json_schema: Schema.optionalKey(OpenCodeJsonSchemaSpec)
}) {}

export class OpenCodeCompletionRequest extends Schema.Class<OpenCodeCompletionRequest>(
  "OpenCodeCompletionRequest"
)({
  model: Schema.String,
  messages: Schema.Array(OpenCodeMessage),
  temperature: Schema.optionalKey(Schema.Number),
  max_tokens: Schema.optionalKey(Schema.Int),
  max_completion_tokens: Schema.optionalKey(Schema.Int),
  stream: Schema.optionalKey(Schema.Boolean),
  response_format: Schema.optionalKey(OpenCodeResponseFormat)
}) {}

export class OpenCodeDelta extends Schema.Class<OpenCodeDelta>("OpenCodeDelta")({
  content: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class OpenCodeChoice extends Schema.Class<OpenCodeChoice>("OpenCodeChoice")({
  index: Schema.optionalKey(Schema.Int),
  message: Schema.optionalKey(OpenCodeMessage),
  delta: Schema.optionalKey(OpenCodeDelta),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class OpenCodeTokenUsage extends Schema.Class<OpenCodeTokenUsage>("OpenCodeTokenUsage")({
  prompt_tokens: Schema.optionalKey(Schema.Int),
  completion_tokens: Schema.optionalKey(Schema.Int),
  total_tokens: Schema.optionalKey(Schema.Int)
}) {}

export class OpenCodeCompletionResponse extends Schema.Class<OpenCodeCompletionResponse>(
  "OpenCodeCompletionResponse"
)({
  id: Schema.optionalKey(Schema.String),
  choices: Schema.Array(OpenCodeChoice),
  usage: Schema.optionalKey(OpenCodeTokenUsage),
  model: Schema.optionalKey(Schema.String)
}) {}
