import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { JsonSchema } from "../Models.ts"

const empty = <A>(): ReadonlyArray<A> => Object.freeze([])

const arrayWithDefaults = <A extends Schema.Top>(item: A) =>
  Schema.Array(item).pipe(
    Schema.withConstructorDefault(Effect.succeed(empty<typeof item.Type>())),
    Schema.withDecodingDefault(Effect.succeed(empty<typeof item.Encoded>()))
  )

export class GeminiGenerationConfig extends Schema.Class<GeminiGenerationConfig>(
  "GeminiGenerationConfig"
)({
  responseMimeType: Schema.optionalKey(Schema.String),
  responseSchema: Schema.optionalKey(JsonSchema)
}) {}

export class GeminiPart extends Schema.Class<GeminiPart>("GeminiPart")({
  text: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class GeminiContent extends Schema.Class<GeminiContent>("GeminiContent")({
  parts: Schema.Array(GeminiPart)
}) {}

export class GeminiGenerateContentRequest extends Schema.Class<GeminiGenerateContentRequest>(
  "GeminiGenerateContentRequest"
)({
  contents: Schema.Array(GeminiContent),
  generationConfig: Schema.optionalKey(GeminiGenerationConfig)
}) {}

export class GeminiUsageMetadata extends Schema.Class<GeminiUsageMetadata>("GeminiUsageMetadata")({
  promptTokenCount: Schema.optionalKey(Schema.Int),
  candidatesTokenCount: Schema.optionalKey(Schema.Int),
  totalTokenCount: Schema.optionalKey(Schema.Int)
}) {}

export class GeminiCandidate extends Schema.Class<GeminiCandidate>("GeminiCandidate")({
  content: GeminiContent,
  finishReason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class GeminiGenerateContentResponse extends Schema.Class<GeminiGenerateContentResponse>(
  "GeminiGenerateContentResponse"
)({
  candidates: arrayWithDefaults(GeminiCandidate),
  usageMetadata: Schema.optionalKey(GeminiUsageMetadata)
}) {}

export class GeminiFunctionDeclaration extends Schema.Class<GeminiFunctionDeclaration>(
  "GeminiFunctionDeclaration"
)({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonSchema
}) {}

export class GeminiToolDef extends Schema.Class<GeminiToolDef>("GeminiToolDef")({
  functionDeclarations: Schema.Array(GeminiFunctionDeclaration)
}) {}

export class GeminiFunctionCall extends Schema.Class<GeminiFunctionCall>("GeminiFunctionCall")({
  name: Schema.String,
  args: Schema.Json
}) {}

export class GeminiPartFull extends Schema.Class<GeminiPartFull>("GeminiPartFull")({
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  functionCall: Schema.optionalKey(GeminiFunctionCall)
}) {}

export class GeminiContentFull extends Schema.Class<GeminiContentFull>("GeminiContentFull")({
  parts: Schema.Array(GeminiPartFull)
}) {}

export class GeminiCandidateFull extends Schema.Class<GeminiCandidateFull>("GeminiCandidateFull")({
  content: GeminiContentFull,
  finishReason: Schema.optionalKey(Schema.NullOr(Schema.String))
}) {}

export class GeminiGenerateContentResponseFull extends Schema.Class<GeminiGenerateContentResponseFull>(
  "GeminiGenerateContentResponseFull"
)({
  candidates: arrayWithDefaults(GeminiCandidateFull),
  usageMetadata: Schema.optionalKey(GeminiUsageMetadata)
}) {}

export class GeminiGenerateContentRequestWithTools extends Schema.Class<GeminiGenerateContentRequestWithTools>(
  "GeminiGenerateContentRequestWithTools"
)({
  contents: Schema.Array(GeminiContent),
  tools: Schema.Array(GeminiToolDef),
  generationConfig: Schema.optionalKey(GeminiGenerationConfig)
}) {}
