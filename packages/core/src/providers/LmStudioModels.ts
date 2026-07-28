import * as Schema from "effect/Schema"

export class LmStudioInput extends Schema.Class<LmStudioInput>("LmStudioInput")({
  type: Schema.String,
  content: Schema.optionalKey(Schema.String),
  data_url: Schema.optionalKey(Schema.String)
}) {}

export const LmStudioInputPayload = Schema.Union([Schema.String, Schema.Array(LmStudioInput)])
export type LmStudioInputPayload = typeof LmStudioInputPayload.Type

export class LmStudioPluginIntegration extends Schema.Class<LmStudioPluginIntegration>(
  "LmStudioPluginIntegration"
)({
  type: Schema.String,
  id: Schema.String,
  allowed_tools: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

export class LmStudioEphemeralMcpIntegration extends Schema.Class<LmStudioEphemeralMcpIntegration>(
  "LmStudioEphemeralMcpIntegration"
)({
  type: Schema.String,
  server_label: Schema.String,
  server_url: Schema.String,
  allowed_tools: Schema.optionalKey(Schema.Array(Schema.String)),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
}) {}

export const LmStudioIntegration = Schema.Union([
  LmStudioPluginIntegration,
  LmStudioEphemeralMcpIntegration
])
export type LmStudioIntegration = typeof LmStudioIntegration.Type

export class LmStudioChatRequest extends Schema.Class<LmStudioChatRequest>("LmStudioChatRequest")({
  model: Schema.String,
  input: LmStudioInputPayload,
  system_prompt: Schema.optionalKey(Schema.String),
  integrations: Schema.optionalKey(Schema.Array(LmStudioIntegration)),
  stream: Schema.optionalKey(Schema.Boolean),
  temperature: Schema.optionalKey(Schema.Number),
  top_p: Schema.optionalKey(Schema.Number),
  top_k: Schema.optionalKey(Schema.Int),
  min_p: Schema.optionalKey(Schema.Number),
  repeat_penalty: Schema.optionalKey(Schema.Number),
  max_output_tokens: Schema.optionalKey(Schema.Int),
  reasoning: Schema.optionalKey(Schema.String),
  context_length: Schema.optionalKey(Schema.Int),
  store: Schema.optionalKey(Schema.Boolean),
  previous_response_id: Schema.optionalKey(Schema.String)
}) {}

export class LmStudioMessage extends Schema.Class<LmStudioMessage>("LmStudioMessage")({
  role: Schema.String,
  content: Schema.String,
  name: Schema.optionalKey(Schema.String)
}) {}

export class LmStudioOutputItem extends Schema.Class<LmStudioOutputItem>("LmStudioOutputItem")({
  type: Schema.String,
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.Json),
  output: Schema.optionalKey(Schema.String),
  provider_info: Schema.optionalKey(Schema.Json),
  reason: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Json)
}) {}

export class LmStudioStats extends Schema.Class<LmStudioStats>("LmStudioStats")({
  input_tokens: Schema.optionalKey(Schema.Int),
  total_output_tokens: Schema.optionalKey(Schema.Int),
  reasoning_output_tokens: Schema.optionalKey(Schema.Int),
  tokens_per_second: Schema.optionalKey(Schema.Number),
  time_to_first_token_seconds: Schema.optionalKey(Schema.Number),
  model_load_time_seconds: Schema.optionalKey(Schema.Number)
}) {}

export class LmStudioChatResponse extends Schema.Class<LmStudioChatResponse>(
  "LmStudioChatResponse"
)({
  model_instance_id: Schema.String,
  output: Schema.Array(LmStudioOutputItem),
  stats: Schema.optionalKey(LmStudioStats),
  response_id: Schema.optionalKey(Schema.String)
}) {}

export class LmStudioModel extends Schema.Class<LmStudioModel>("LmStudioModel")({
  id: Schema.String,
  path: Schema.String,
  type: Schema.String,
  loaded: Schema.Boolean,
  architecture: Schema.optionalKey(Schema.String)
}) {}

export class LmStudioModelsResponse extends Schema.Class<LmStudioModelsResponse>(
  "LmStudioModelsResponse"
)({
  models: Schema.Array(LmStudioModel)
}) {}

export class LmStudioLoadModelRequest extends Schema.Class<LmStudioLoadModelRequest>(
  "LmStudioLoadModelRequest"
)({
  model: Schema.String,
  context_length: Schema.optionalKey(Schema.Int),
  gpu_layers: Schema.optionalKey(Schema.Int)
}) {}

export class LmStudioLoadModelResponse extends Schema.Class<LmStudioLoadModelResponse>(
  "LmStudioLoadModelResponse"
)({
  success: Schema.Boolean,
  model: Schema.String,
  message: Schema.optionalKey(Schema.String)
}) {}
