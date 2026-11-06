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
