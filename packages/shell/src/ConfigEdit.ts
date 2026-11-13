// The decisions of `llm4ts config edit`, as pure functions: which rows the
// picker lists, what a setting offers, how its value is asked, which file a
// value goes to. The prompts that ask live in ConfigCommand.ts. Only settings
// a file may hold are listed, so no row can carry a secret.
import * as Result from "effect/Result"
import {
  closestSettingName,
  groupTitles,
  type SettingFacts,
  type SettingName
} from "@llm4ts/flow/Settings"
import { storeRefusal, unknownText, type FileLayer, type Resolution } from "./Config.ts"

/** The settings a config file may hold, in registry order. */
export const editableFacts = (facts: ReadonlyArray<SettingFacts>): ReadonlyArray<SettingFacts> =>
  facts.filter((fact) => fact.scope === "global" || fact.scope === "project")

export interface PickerRow {
  readonly name: SettingName
  /** Name, value and source in columns; the picker filters on it. */
  readonly title: string
  /** The group's title. */
  readonly description: string
}

const valueWidth = 30

const clipped = (text: string): string =>
  text.length > valueWidth ? `${text.slice(0, valueWidth - 1)}…` : text

/**
 * The picker's rows: every setting some layer sets, then the rest, each part
 * in registry order, so the groups stay together.
 */
export const pickerRows = (resolution: Resolution): ReadonlyArray<PickerRow> => {
  const editable = editableFacts(resolution.facts)
  const titles = new Map<string, string>(groupTitles)
  const nameWidth = Math.max(0, ...editable.map((fact) => fact.name.length))
  const row = (fact: SettingFacts): PickerRow => {
    const setting = resolution.settings.get(fact.name)
    const value =
      setting === undefined
        ? `(default: ${fact.fallback.text})`
        : setting.raw.length === 0
          ? "(empty)"
          : setting.raw
    return {
      name: fact.name,
      title: `${fact.name.padEnd(nameWidth)}  ${clipped(value).padEnd(valueWidth)}  ${setting?.source.layer ?? "default"}`,
      description: titles.get(fact.group) ?? fact.group
    }
  }
  return [
    ...editable.filter((fact) => resolution.settings.has(fact.name)),
    ...editable.filter((fact) => !resolution.settings.has(fact.name))
  ].map(row)
}

/** One line on the settings the picker leaves out and how each kind is set. */
export const unlistedHint =
  "not listed: per-run settings (llm4ts run <flow> --set NAME=value) and secrets (export them in your shell)"

/**
 * What `config edit [NAME]` opens: the picker (`undefined`) or one setting.
 * Refuses a name that is not a setting, with the closest one, a setting no
 * file may hold, with where it is set instead, and a session off a terminal.
 */
export const editRequest = (
  facts: ReadonlyArray<SettingFacts>,
  request: { readonly name?: string; readonly interactive: boolean }
): Result.Result<SettingName | undefined, string> => {
  const fact =
    request.name === undefined ? undefined : facts.find((known) => known.name === request.name)
  if (request.name !== undefined && fact === undefined) {
    return Result.fail(unknownText(request.name, closestSettingName(request.name)))
  }
  const refusal = fact === undefined ? undefined : storeRefusal(fact)
  if (refusal !== undefined) {
    return Result.fail(refusal)
  }
  return request.interactive
    ? Result.succeed(fact?.name)
    : Result.fail(
        `config edit asks its questions on a terminal; here use llm4ts config set ${fact?.name ?? "NAME"}=value`
      )
}

export type SettingAction =
  | { readonly kind: "change" }
  | { readonly kind: "remove"; readonly layer: FileLayer }
  | { readonly kind: "back" }

export interface ActionChoice {
  readonly title: string
  readonly action: SettingAction
}

/** What an open setting offers; a removal only for a file that holds it. */
export const settingActions = (held: ReadonlyArray<FileLayer>): ReadonlyArray<ActionChoice> => [
  { title: "change the value", action: { kind: "change" } },
  ...held.map(
    (layer): ActionChoice => ({
      title: `remove it from the ${layer} file`,
      action: { kind: "remove", layer }
    })
  ),
  { title: "back", action: { kind: "back" } }
]

export type ValuePrompt =
  | { readonly kind: "toggle" }
  | { readonly kind: "choices"; readonly choices: ReadonlyArray<string> }
  | { readonly kind: "seat" }
  | { readonly kind: "text" }

/** The settings that name a coding agent, asked from the agents `config init` lists. */
export const seatSettings: ReadonlyArray<SettingName> = ["LLM4TS_CODER", "LLM4TS_REASONER"]

/** How a setting's new value is asked. */
export const valuePrompt = (fact: SettingFacts): ValuePrompt =>
  fact.toggle
    ? { kind: "toggle" }
    : seatSettings.includes(fact.name)
      ? { kind: "seat" }
      : fact.choices.length > 0
        ? { kind: "choices", choices: fact.choices }
        : { kind: "text" }

/**
 * The files a new value may go to, the default first; one file means there
 * is nothing to ask. A global setting edited inside a repository may be meant
 * for that repository only, and defaults to the project file once that file
 * holds it, where a global line would stay shadowed.
 */
export const saveTargets = (
  fact: SettingFacts,
  where: {
    readonly inRepository: boolean
    /** The project file is not trusted, so nothing is written to it. */
    readonly projectRefused: boolean
    readonly held: ReadonlyArray<FileLayer>
  }
): ReadonlyArray<FileLayer> =>
  fact.scope !== "global"
    ? ["project"]
    : !where.inRepository || where.projectRefused
      ? ["global"]
      : where.held.includes("project")
        ? ["project", "global"]
        : ["global", "project"]

export const targetTitles: Readonly<Record<FileLayer, string>> = {
  global: "every repository (global)",
  project: "this repository only"
}

/** The line shown when an export decides the value whatever a file says. */
export const environmentNote = (resolution: Resolution, name: SettingName): string | undefined =>
  resolution.settings.get(name)?.source.layer === "environment"
    ? `${name} is exported in this shell: the export keeps winning over whatever is saved here.`
    : undefined

export interface SessionChange {
  readonly name: SettingName
  readonly layer: FileLayer
  readonly kind: "set" | "removed"
}

/** One line on what the session left in the files; the last change to a line counts. */
export const sessionSummary = (changes: ReadonlyArray<SessionChange>): string => {
  const last = new Map<string, SessionChange>()
  for (const change of changes) {
    last.set(`${change.layer} ${change.name}`, change)
  }
  return last.size === 0
    ? "nothing changed"
    : `changed: ${[...last.values()]
        .map((change) => `${change.kind} ${change.name} (${change.layer})`)
        .join(", ")}`
}
