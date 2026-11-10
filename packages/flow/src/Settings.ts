import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  settings,
  type Fallback,
  type Setting,
  type SettingGroup,
  type SettingScope
} from "./settings/Registry.ts"
import type * as Value from "./settings/Value.ts"

export type { SettingGroup, SettingScope }
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

/**
 * The setting's value in `environment`. Unset: the default when the setting
 * has one, else `undefined`. A value the grammar does not read counts as
 * unset, as it did for every reader before the registry.
 */
export const settingValue = <N extends SettingName>(
  name: N,
  environment: Environment
): Reading<N> => {
  const unset = entries[name].fallback.value
  const raw = environment[name]
  if (raw === undefined) {
    return unset
  }
  const read = readSetting(name, raw)
  return Result.isSuccess(read) && read.success !== undefined ? read.success : unset
}

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
