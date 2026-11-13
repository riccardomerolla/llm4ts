import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  settingGroups,
  settings,
  type Fallback,
  type Setting,
  type SettingGroup,
  type SettingScope
} from "./settings/Registry.ts"
import * as Value from "./settings/Value.ts"

export type { SettingGroup, SettingScope }

/** Each group's id and title, in the order docs and `config show --all` print them. */
export const groupTitles: ReadonlyArray<readonly [SettingGroup, string]> = settingGroups
export type Environment = Readonly<Record<string, string | undefined>>

/** The registry's keys: a misspelled name does not compile. */
export type SettingName = keyof typeof settings

type Values = {
  readonly [N in SettingName]: (typeof settings)[N]["value"] extends Value.SettingValue<infer A>
    ? A
    : never
}
type Unset = { readonly [N in SettingName]: (typeof settings)[N]["fallback"]["value"] }

/** What a setting's grammar decodes to. */
export type ValueOf<N extends SettingName> = Values[N]
/** What `settingValue` returns: the value, or `undefined` when unset with no single default. */
export type Reading<N extends SettingName> = Values[N] | Unset[N]

// The registry seen through its own key: indexing by a generic name keeps the
// value type and the fallback type of that one setting together.
const entries: {
  readonly [N in SettingName]: Setting<
    Values[N],
    Fallback<Values[N]> & { readonly value: Unset[N] }
  >
} = settings

/** What the shell, the docs and `config show` read about a setting; never its schema. */
export interface SettingFacts {
  readonly name: SettingName
  readonly group: SettingGroup
  readonly scope: SettingScope
  /** "on or off", "a positive integer": what docs and errors print. */
  readonly grammar: string
  /** The grammar is the shared on/off one. */
  readonly toggle: boolean
  /** Every value the grammar reads, as it is written; empty when the grammar is open. */
  readonly choices: ReadonlyArray<string>
  /** A filesystem path, made absolute when it comes from a file. */
  readonly path: boolean
  /** llm4ts runs the value as a command. */
  readonly runs: boolean
  /** An empty value means something, so it does not count as unset. */
  readonly emptyIsValue: boolean
  readonly fallback: { readonly kind: "default" | "per-flow" | "off"; readonly text: string }
  readonly doc: string
  /** The `llm4ts run` flag that also sets it. */
  readonly flag?: string
  /** Flows that stop without it whatever their arguments. */
  readonly requiredBy: ReadonlyArray<string>
  /** Read by the shell only; never handed to a flow. */
  readonly shellOnly: boolean
}

export const isSettingName = (name: string): name is SettingName => Object.hasOwn(settings, name)

/** Every setting, in registry order: grouped as the docs are. */
export const settingNames: ReadonlyArray<SettingName> = Object.keys(settings).filter(isSettingName)

const fallbackKinds = { Default: "default", PerFlow: "per-flow", Off: "off" } as const

export const settingFacts = (name: SettingName): SettingFacts => {
  const entry: Setting<unknown, Fallback<unknown>> = settings[name]
  return {
    name,
    group: entry.group,
    scope: entry.scope,
    grammar: entry.value.grammar,
    toggle: entry.value === Value.toggle,
    choices: entry.value.choices,
    path: entry.value.path,
    runs: entry.value.runs,
    emptyIsValue: entry.value.empty === "value",
    fallback: { kind: fallbackKinds[entry.fallback._tag], text: entry.fallback.text },
    doc: entry.doc,
    ...(entry.flag === undefined ? {} : { flag: entry.flag }),
    requiredBy: entry.requiredBy ?? [],
    shellOnly: entry.shellOnly === true
  }
}

/**
 * One raw string read by the setting's grammar. An empty string succeeds with
 * `undefined` (unset) unless the grammar gives empty a meaning. The failure is
 * the grammar phrase; it never carries the raw value, so a secret cannot leak
 * through it.
 */
export const readSetting = <N extends SettingName>(
  name: N,
  raw: string
): Result.Result<ValueOf<N> | undefined, string> => {
  const value = entries[name].value
  if (raw.trim().length === 0 && value.empty === "unset") {
    return Result.succeed(undefined)
  }
  const decoded = Schema.decodeUnknownOption(value.schema)(raw)
  return Option.isSome(decoded) ? Result.succeed(decoded.value) : Result.fail(value.grammar)
}

/** What the environment holds for a setting, before any default. */
export type Given<N extends SettingName> =
  | { readonly _tag: "Unset" }
  | { readonly _tag: "Read"; readonly value: ValueOf<N> }
  /** `text` is the trimmed value the grammar did not read: to report or refuse, never to parse. */
  | { readonly _tag: "Unreadable"; readonly text: string }

/**
 * `settingValue` without the default, for a reader that keeps its own default
 * or tells an unreadable value from an unset one.
 */
export const settingGiven = <N extends SettingName>(
  name: N,
  environment: Environment
): Given<N> => {
  const raw = environment[name]
  if (raw === undefined) {
    return { _tag: "Unset" }
  }
  const read = readSetting(name, raw)
  if (Result.isFailure(read)) {
    return { _tag: "Unreadable", text: raw.trim() }
  }
  return read.success === undefined ? { _tag: "Unset" } : { _tag: "Read", value: read.success }
}

/**
 * The setting's value in `environment`. Unset: the default when the setting
 * has one, else `undefined`. A value the grammar does not read counts as
 * unset, as it did for every reader before the registry.
 */
export const settingValue = <N extends SettingName>(
  name: N,
  environment: Environment
): Reading<N> => {
  const given = settingGiven(name, environment)
  return given._tag === "Read" ? given.value : entries[name].fallback.value
}

type Spelled = {
  readonly [N in SettingName]: Values[N] extends string | number ? N : never
}[SettingName]

/**
 * The setting as the text to look up or quote: the value read, else the text
 * the grammar refused, else `undefined`. For a reader that names what it was
 * given in its own refusal.
 */
export const settingText = (name: Spelled, environment: Environment): string | undefined => {
  const given = settingGiven(name, environment)
  return given._tag === "Read"
    ? String(given.value)
    : given._tag === "Unreadable"
      ? given.text
      : undefined
}

const belongsIn: Readonly<Record<SettingScope, string>> = {
  global: "global file",
  project: "project file",
  run: "per run",
  secret: "environment only",
  internal: "set by llm4ts"
}

// Outside code spans, a variable name or a `<placeholder>` word becomes a code
// span: Markdown would otherwise read `<repo>` as an HTML tag.
const codeWord = /[^\s`]*<[a-z-]+>[^\s`,;:)]*|\b[A-Z][A-Z0-9]*_(?:[A-Z0-9_]*[A-Z0-9]\b|\*)/gu

const cell = (text: string): string =>
  text
    .split("`")
    .map((part, index) => (index % 2 === 0 ? part.replace(codeWord, "`$&`") : part))
    .join("`")
    .replaceAll("|", "\\|")

const table = (rows: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<string> => {
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(3, ...rows.map((row) => (row[column] ?? "").length))
  )
  const line = (row: ReadonlyArray<string>): string =>
    `| ${row.map((text, column) => text.padEnd(widths[column] ?? 0)).join(" | ")} |`
  const [head = [], ...body] = rows
  return [
    line(head),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line)
  ]
}

/**
 * The settings reference of `docs/configuration.md`: one table per group, in
 * registry order, already laid out the way Prettier lays out a Markdown
 * table. `scripts/settings-docs.mjs` writes it into the document.
 */
export const settingsReference = (): string =>
  groupTitles
    .flatMap(([group, title]) => {
      const rows = settingNames
        .map(settingFacts)
        .filter((facts) => facts.group === group)
        .map((facts) => [
          `\`${facts.name}\``,
          cell(facts.grammar) + (facts.runs ? " (run as a command)" : ""),
          cell(facts.fallback.text),
          belongsIn[facts.scope],
          facts.requiredBy.map((flow) => `\`${flow}\``).join(", "),
          cell(facts.doc) + (facts.flag === undefined ? "" : ` Flag: \`${facts.flag}\`.`)
        ])
      // A column no row of the group fills is left out.
      const columns = [
        "Setting",
        "Value",
        "Default",
        "Belongs in",
        "Required by",
        "Meaning"
      ].flatMap((heading, column) =>
        rows.some((row) => row[column] !== "") ? [[heading, column] as const] : []
      )
      return rows.length === 0
        ? []
        : [
            `### ${title}`,
            "",
            ...table([
              columns.map(([heading]) => heading),
              ...rows.map((row) => columns.map(([, column]) => row[column] ?? ""))
            ]),
            ""
          ]
    })
    .join("\n")
    .trimEnd()

const prefix = "LLM4TS_"

/** Damerau-Levenshtein in its optimal-string-alignment form: a swap of two neighbours costs 1. */
const editDistance = (left: string, right: string): number => {
  let twoBack: ReadonlyArray<number> = []
  let previous: ReadonlyArray<number> = Array.from({ length: right.length + 1 }, (_, j) => j)
  for (let i = 1; i <= left.length; i++) {
    const current = [i]
    for (let j = 1; j <= right.length; j++) {
      const same = left[i - 1] === right[j - 1]
      const swapped = i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]
      current.push(
        Math.min(
          (previous[j] ?? 0) + 1,
          (current[j - 1] ?? 0) + 1,
          (previous[j - 1] ?? 0) + (same ? 0 : 1),
          swapped ? (twoBack[j - 2] ?? 0) + 1 : Number.POSITIVE_INFINITY
        )
      )
    }
    twoBack = previous
    previous = current
  }
  return previous[right.length] ?? 0
}

const wordsOf = (suffix: string): string => suffix.split("_").sort().join("_")

/**
 * The setting a misspelled `LLM4TS_*` name most likely meant: the one at the
 * smallest edit distance over the part after the prefix, when that is at most
 * 2 or a quarter of the length, else the one made of the same `_`-separated
 * words in another order. `undefined` when nothing is close.
 */
export const closestSettingName = (name: string): SettingName | undefined => {
  const given = name.trim().toUpperCase()
  if (!given.startsWith(prefix)) {
    return undefined
  }
  if (isSettingName(given)) {
    return given
  }
  const suffix = given.slice(prefix.length)
  let closest: { readonly name: SettingName; readonly distance: number } | undefined
  for (const candidate of settingNames) {
    const known = candidate.slice(prefix.length)
    const distance = editDistance(suffix, known)
    const limit = Math.max(2, Math.floor(Math.max(suffix.length, known.length) / 4))
    // A distance as long as the shorter name is a different name, not a typo of it.
    const typo = distance <= limit && distance < Math.min(suffix.length, known.length)
    if (typo && (closest === undefined || distance < closest.distance)) {
      closest = { name: candidate, distance }
    }
  }
  return (
    closest?.name ??
    settingNames.find((candidate) => wordsOf(candidate.slice(prefix.length)) === wordsOf(suffix))
  )
}
