import type { JsonValue } from "../providers/CliSupport.ts"

export interface RedactionOptions {
  readonly secrets?: ReadonlyArray<string>
  readonly maxLength?: number
}

const sensitiveKey = /(?:api[-_]?key|authorization|cookie|password|secret|token)/i
const credentialPatterns: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\b(?:sk|xox[baprs]|gh[opusr])[-_][A-Za-z0-9_-]{8,}\b/g
]

export const redactText = (text: string, options: RedactionOptions = {}): string => {
  let redacted = text
  for (const secret of options.secrets ?? []) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]")
    }
  }
  for (const pattern of credentialPatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]")
  }
  const maxLength = Math.max(0, options.maxLength ?? 2_048)
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…[TRUNCATED]`
}

const sanitizeValue = (value: JsonValue, options: RedactionOptions): JsonValue => {
  if (typeof value === "string") {
    return redactText(value, options)
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, options))
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : sanitizeValue(child, options)
      ])
    )
  }
  return value
}

export const sanitizeFields = (
  fields: Readonly<Record<string, JsonValue>>,
  options: RedactionOptions = {}
): Readonly<Record<string, JsonValue>> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : sanitizeValue(value, options)
    ])
  )
