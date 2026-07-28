import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { SchemaError } from "effect/SchemaError"
import { ParseError, ProviderError, type LlmError } from "./Errors.ts"
import type { JsonSchema } from "./Models.ts"

const snippet = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`
}

const extractJsonFromMarkdownFences = (raw: string): ReadonlyArray<string> => {
  const pattern = /```(?:[\w.+-]+)?\s*(.*?)\s*```/gis
  const results: Array<string> = []

  for (const match of raw.matchAll(pattern)) {
    const content = match[1]?.trim()
    if (content !== undefined && content.length > 0) {
      results.push(content)
    }
  }

  return results
}

const extractBalancedJsonObjects = (raw: string): ReadonlyArray<string> => {
  const results: Array<string> = []
  let startIndex: number | undefined
  let depth = 0
  let inString = false
  let escaping = false

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw.charAt(index)

    if (inString) {
      if (escaping) {
        escaping = false
      } else if (character === "\\") {
        escaping = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === "{") {
      startIndex ??= index
      depth += 1
    } else if (character === "}" && depth > 0) {
      depth -= 1
      if (depth === 0 && startIndex !== undefined) {
        results.push(raw.slice(startIndex, index + 1))
        startIndex = undefined
      }
    }
  }

  return results
}

export const jsonCandidates = (raw: string): ReadonlyArray<string> => {
  const fenced = extractJsonFromMarkdownFences(raw)
  const balanced = [
    ...extractBalancedJsonObjects(raw),
    ...fenced.flatMap(extractBalancedJsonObjects)
  ]
  const seen = new Set<string>()
  const candidates: Array<string> = []

  for (const candidate of [raw, ...fenced, ...balanced]) {
    const trimmed = candidate.trim()
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed)
      candidates.push(trimmed)
    }
  }

  return candidates
}

export const withSchemaHint = (prompt: string, schema: JsonSchema): string => {
  if (Object.keys(schema).length === 0) {
    return prompt
  }

  const encoded = JSON.stringify(schema) ?? "{}"
  return `${prompt}\n\nReturn JSON matching this schema:\n${encoded}`
}

interface CandidateFailure {
  readonly candidate: string
  readonly error: SchemaError
}

export const parseFromText = Effect.fn("@llm4ts/core/StructuredOutput.parseFromText")(<
  A,
  E,
  RD,
  RE
>(
  raw: string,
  schema: Schema.ConstraintCodec<A, E, RD, RE>,
  _jsonSchema: JsonSchema
): Effect.Effect<A, LlmError, RD> => {
  if (raw.trim().length === 0) {
    return Effect.fail(
      ProviderError.make({
        message: "empty response from provider — no text to parse as structured output"
      })
    )
  }

  const candidates = jsonCandidates(raw)
  const attempts = candidates.map((candidate) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(candidate).pipe(
      Effect.mapError(
        (error): CandidateFailure => ({
          candidate,
          error
        })
      )
    )
  )

  return Effect.firstSuccessOf(attempts).pipe(
    Effect.mapError(({ candidate, error }) =>
      ParseError.make({
        message:
          `Failed to parse response as structured output: ${String(error)} ` +
          `(tried ${attempts.length} candidate(s); last: ${snippet(candidate)})`,
        raw
      })
    )
  )
})
