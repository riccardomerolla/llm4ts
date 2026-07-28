import * as Schema from "effect/Schema"

export class OllamaOptions extends Schema.Class<OllamaOptions>("OllamaOptions")({
  temperature: Schema.optionalKey(Schema.Number),
  num_predict: Schema.optionalKey(Schema.Int)
}) {}

export class OllamaGenerateRequest extends Schema.Class<OllamaGenerateRequest>(
  "OllamaGenerateRequest"
)({
  model: Schema.String,
  prompt: Schema.String,
  stream: Schema.Boolean,
  format: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(OllamaOptions)
}) {}

export class OllamaMessage extends Schema.Class<OllamaMessage>("OllamaMessage")({
  role: Schema.String,
  content: Schema.String
}) {}

export class OllamaChatRequest extends Schema.Class<OllamaChatRequest>("OllamaChatRequest")({
  model: Schema.String,
  messages: Schema.Array(OllamaMessage),
  stream: Schema.Boolean,
  format: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(OllamaOptions)
}) {}

export class OllamaGenerateResponse extends Schema.Class<OllamaGenerateResponse>(
  "OllamaGenerateResponse"
)({
  model: Schema.String,
  response: Schema.String,
  done: Schema.Boolean,
  context: Schema.optionalKey(Schema.Array(Schema.Int)),
  total_duration: Schema.optionalKey(Schema.Int),
  load_duration: Schema.optionalKey(Schema.Int),
  prompt_eval_count: Schema.optionalKey(Schema.Int),
  eval_count: Schema.optionalKey(Schema.Int)
}) {}

export class OllamaChatResponse extends Schema.Class<OllamaChatResponse>("OllamaChatResponse")({
  model: Schema.String,
  message: OllamaMessage,
  done: Schema.Boolean,
  total_duration: Schema.optionalKey(Schema.Int),
  load_duration: Schema.optionalKey(Schema.Int),
  prompt_eval_count: Schema.optionalKey(Schema.Int),
  eval_count: Schema.optionalKey(Schema.Int)
}) {}

export class OllamaModelInfo extends Schema.Class<OllamaModelInfo>("OllamaModelInfo")({
  name: Schema.String,
  modified_at: Schema.String,
  size: Schema.Int
}) {}

export class OllamaModelsResponse extends Schema.Class<OllamaModelsResponse>(
  "OllamaModelsResponse"
)({
  models: Schema.Array(OllamaModelInfo)
}) {}
