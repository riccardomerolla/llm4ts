import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"

/**
 * How a setting's raw string reads. One instance per grammar, shared by every
 * setting of that grammar, so `on` means the same for all toggles. The same
 * decoding applies whatever the source: flag, environment or file.
 *
 * @internal
 */
export interface SettingValue<A> {
  /** Docs, `config show` and errors print this: "on or off", "a positive integer". */
  readonly grammar: string
  readonly schema: Schema.Codec<A, string>
  /** "unset": an empty string reads as unset. "value": empty means something. */
  readonly empty: "unset" | "value"
  /** A filesystem path: `~` expanded and made absolute when it comes from a file or `config set`. */
  readonly path: boolean
  /** llm4ts runs it as a command (gates, setup, test-one); docs and `config show` say so. */
  readonly runs: boolean
  /** Every value the grammar reads, as it is written; empty when the grammar is open. */
  readonly choices: ReadonlyArray<string>
}

interface Traits {
  readonly empty?: "unset" | "value"
  readonly path?: boolean
  readonly runs?: boolean
  readonly choices?: ReadonlyArray<string>
}

const make = <A>(
  grammar: string,
  target: Schema.Codec<A, A>,
  read: (trimmed: string) => A | undefined,
  write: (value: A) => string,
  traits: Traits = {}
): SettingValue<A> => ({
  grammar,
  schema: Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformEffect({
        decode: (raw: string) => {
          const value = read(raw.trim())
          // The issue never carries the raw text: a secret must not leak through an error.
          return value === undefined
            ? Effect.fail(new SchemaIssue.InvalidValue({ message: grammar }))
            : Effect.succeed(value)
        },
        encode: (value: A) => Effect.succeed(write(value))
      })
    )
  ),
  empty: traits.empty ?? "unset",
  path: traits.path ?? false,
  runs: traits.runs ?? false,
  choices: traits.choices ?? []
})

const integerAtLeast =
  (minimum: number) =>
  (text: string): number | undefined => {
    if (!/^\d+$/u.test(text)) {
      return undefined
    }
    const value = Number.parseInt(text, 10)
    return Number.isSafeInteger(value) && value >= minimum ? value : undefined
  }

const nonEmpty = (text: string): string | undefined => (text.length === 0 ? undefined : text)

const listOf =
  (separator: string) =>
  (text: string): ReadonlyArray<string> | undefined => {
    const parts = text
      .split(separator)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    return parts.length === 0 ? undefined : parts
  }

const onWords: ReadonlyArray<string> = ["1", "true", "on", "yes"]
const offWords: ReadonlyArray<string> = ["0", "false", "off", "no"]

/** 1|true|on|yes and 0|false|off|no, any case: the one boolean grammar. */
export const toggle: SettingValue<boolean> = make(
  "on or off",
  Schema.Boolean,
  (text) => {
    const word = text.toLowerCase()
    return onWords.includes(word) ? true : offWords.includes(word) ? false : undefined
  },
  (value) => (value ? "on" : "off"),
  { choices: ["on", "off"] }
)

/** An integer of at least 1. */
export const positive: SettingValue<number> = make(
  "a positive integer",
  Schema.Number,
  integerAtLeast(1),
  String
)

/** An integer of at least 0; 0 turns the feature off. */
export const count: SettingValue<number> = make(
  "a whole number, 0 or more",
  Schema.Number,
  integerAtLeast(0),
  String
)

/** Whole seconds, at least 1. */
export const seconds: SettingValue<Duration.Duration> = make(
  "a positive number of seconds",
  Schema.Duration,
  (text) => {
    const value = integerAtLeast(1)(text)
    return value === undefined ? undefined : Duration.seconds(value)
  },
  (value) => String(Math.round(Duration.toSeconds(value)))
)

/** Minutes above 0; a fraction is allowed (`0.5`). */
export const minutes: SettingValue<Duration.Duration> = make(
  "a positive number of minutes",
  Schema.Duration,
  (text) => {
    if (!/^(\d+\.?\d*|\.\d+)$/u.test(text)) {
      return undefined
    }
    const value = Number.parseFloat(text)
    return Number.isFinite(value) && value > 0 ? Duration.minutes(value) : undefined
  },
  (value) => String(Duration.toMinutes(value))
)

const spanUnits: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600 }

/** A span such as `90s`, `5m`, `1h`; a bare number is seconds. */
export const span: SettingValue<Duration.Duration> = make(
  "a span such as 90s, 5m or 1h",
  Schema.Duration,
  (text) => {
    const match = /^(\d+)\s*([smh])?$/iu.exec(text)
    if (match === null) {
      return undefined
    }
    const amount = Number.parseInt(match[1] ?? "", 10)
    const unit = spanUnits[(match[2] ?? "s").toLowerCase()]
    return unit === undefined || !Number.isSafeInteger(amount)
      ? undefined
      : Duration.seconds(amount * unit)
  },
  (value) => `${Math.round(Duration.toSeconds(value))}s`
)

/** Non-empty text, trimmed. */
export const text: SettingValue<string> = make("text", Schema.String, nonEmpty, (value) => value)

export const path: SettingValue<string> = make(
  "a path",
  Schema.String,
  nonEmpty,
  (value) => value,
  { path: true }
)

export const url: SettingValue<string> = make(
  "an http or https URL",
  Schema.String,
  (value) => (/^https?:\/\//iu.test(value) && URL.canParse(value) ? value : undefined),
  (value) => value
)

/** One command line. */
export const command: SettingValue<string> = make(
  "a command line",
  Schema.String,
  nonEmpty,
  (value) => value,
  { runs: true }
)

/** One command line, where an empty value means "run nothing" instead of "unset". */
export const commandOrNone: SettingValue<string> = make(
  "a command line; empty runs none",
  Schema.String,
  (value) => value,
  (value) => value,
  { runs: true, empty: "value" }
)

/** `cmd; cmd`. */
export const commands: SettingValue<ReadonlyArray<string>> = make(
  "command lines separated by ;",
  Schema.Array(Schema.String),
  listOf(";"),
  (value) => value.join("; "),
  { runs: true }
)

/** Comma-separated names. */
export const names: SettingValue<ReadonlyArray<string>> = make(
  "names separated by commas",
  Schema.Array(Schema.String),
  listOf(","),
  (value) => value.join(",")
)

/** `key=value;key=value`, extra CLI flags for a seat; a bare `key` is a boolean flag. */
export const cliFlags: SettingValue<Readonly<Record<string, string>>> = make(
  "key=value pairs separated by ;",
  Schema.Record(Schema.String, Schema.String),
  (value) => {
    const entries = (listOf(";")(value) ?? []).map((entry): readonly [string, string] => {
      // The first `=` splits, so a value may itself carry `=`.
      const at = entry.indexOf("=")
      return at < 0 ? [entry, ""] : [entry.slice(0, at).trim(), entry.slice(at + 1).trim()]
    })
    return entries.length === 0 || entries.some(([key]) => key.length === 0)
      ? undefined
      : Object.fromEntries(entries)
  },
  (value) =>
    Object.entries(value)
      .map(([key, flag]) => (flag.length === 0 ? key : `${key}=${flag}`))
      .join(";")
)

/** One of `choices`, any case; choices are written in lower case. */
export const oneOf = <const L extends ReadonlyArray<string>>(choices: L): SettingValue<L[number]> =>
  make<L[number]>(
    choices.join(", ").replace(/, ([^,]*)$/u, " or $1"),
    Schema.Literals(choices),
    (value) => choices.find((choice) => choice === value.toLowerCase()),
    (value) => value,
    { choices }
  )
