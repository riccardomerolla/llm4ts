import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"

export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()("ProviderError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class UsageLimitError extends Schema.TaggedErrorClass<UsageLimitError>()("UsageLimitError", {
  resetAt: Schema.optionalKey(Schema.DateTimeUtc),
  provider: Schema.String,
  message: Schema.String
}) {}

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  "AuthenticationError",
  {
    message: Schema.String
  }
) {}

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  {
    message: Schema.String
  }
) {}

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  message: Schema.String,
  raw: Schema.String
}) {}

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ToolError", {
  toolName: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `tool '${this.toolName}' failed: ${this.detail}`
  }
}

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String
}) {}

export class RateLimitError extends Schema.TaggedErrorClass<RateLimitError>()("RateLimitError", {
  retryAfter: Schema.optionalKey(Schema.Duration)
}) {
  get message(): string {
    return this.retryAfter === undefined
      ? "rate limited"
      : `rate limited; retry after ${Duration.format(this.retryAfter)}`
  }
}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("TimeoutError", {
  duration: Schema.Duration
}) {
  get message(): string {
    return `timed out after ${Duration.format(this.duration)}`
  }
}

export class TurnLimitError extends Schema.TaggedErrorClass<TurnLimitError>()("TurnLimitError", {
  limit: Schema.optionalKey(Schema.Int)
}) {
  get message(): string {
    return this.limit === undefined
      ? "turn limit reached"
      : `turn limit reached after ${this.limit} turn(s)`
  }
}

export const LlmError = Schema.Union([
  ProviderError,
  UsageLimitError,
  AuthenticationError,
  InvalidRequestError,
  ParseError,
  ToolError,
  ConfigError,
  RateLimitError,
  TimeoutError,
  TurnLimitError
])
export type LlmError = typeof LlmError.Type
