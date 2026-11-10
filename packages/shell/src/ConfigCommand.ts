// `llm4ts config show | set | unset | init | edit | trust | untrust`: the
// config files seen, edited and accepted from the command line. Every renderer is pure and never prints a secret.
import { resolve } from "node:path"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { Argument, Command, Flag, Prompt } from "effect/cli"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  closestSettingName,
  groupTitles,
  isSettingName,
  readSetting,
  type Environment,
  type SettingFacts,
  type SettingName
} from "@llm4ts/flow/Settings"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { coderChoices, findOnPath } from "./CoderChoice.ts"
import {
  expandPath,
  globalConfigPath,
  homeOf,
  loadConfig,
  parseConfigFile,
  planSet,
  projectConfigPath,
  registryFacts,
  writeConfig,
  type ConfigChange,
  type ConfigFile,
  type FileLayer,
  type Layered,
  type LoadedConfig,
  type Source
} from "./Config.ts"
import {
  configTrustPath,
  contentHash,
  forgetTrust,
  loadTrustStore,
  recordTrust,
  trustCommand,
  trustDecision,
  writeRefusal,
  type Distrust
} from "./ConfigTrust.ts"
import {
  editRequest,
  environmentNote,
  pickerRows,
  saveTargets,
  sessionSummary,
  settingActions,
  targetTitles,
  unlistedHint,
  valuePrompt,
  type SessionChange,
  type SettingAction
} from "./ConfigEdit.ts"
import { ShellUsageError } from "./ShellErrors.ts"

/** Provider keys the connectors read. `config show` says set or unset, never more. */
export const foreignCredentials: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "TYPESAFE_API_KEY"
]

export interface ConfigView {
  readonly loaded: LoadedConfig
  readonly environment: Environment
  readonly globalPath: string
  readonly projectPath: string
  readonly repo: string
  readonly home: string
}

const facts = new Map<string, SettingFacts>(registryFacts.map((fact) => [fact.name, fact]))

const tilde = (path: string, home: string): string =>
  path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path

const table = (rows: ReadonlyArray<ReadonlyArray<string>>, indent = ""): ReadonlyArray<string> => {
  const widths: Array<number> = []
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return rows.map((row) =>
    `${indent}${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("   ")}`.trimEnd()
  )
}

const sourceLabel = (source: Source): string =>
  source.layer === "flag" || source.layer === "environment"
    ? source.layer
    : `${source.layer}:${source.line}`

const shown = (raw: string, secret: boolean): string =>
  secret ? "(secret, set)" : raw.length === 0 ? "(empty)" : raw

const suppliedBy = (view: ConfigView, layer: FileLayer): number =>
  [...view.loaded.resolution.settings.values()].filter((setting) =>
    [setting, ...setting.shadowed].some((layered) => layered.source.layer === layer)
  ).length

const counted = (count: number): string => (count === 1 ? "1 setting" : `${count} settings`)

type FileState = "absent" | "present" | Distrust

const fileStates = (
  view: ConfigView
): ReadonlyArray<{
  readonly layer: FileLayer
  readonly path: string
  readonly state: FileState
  readonly settings: number
}> => [
  {
    layer: "global",
    path: view.globalPath,
    state: view.loaded.global === undefined ? "absent" : "present",
    settings: suppliedBy(view, "global")
  },
  {
    layer: "project",
    path: view.projectPath,
    state: view.loaded.projectTrust === "trusted" ? "present" : view.loaded.projectTrust,
    settings: suppliedBy(view, "project")
  }
]

const stateText = (file: { readonly state: FileState; readonly settings: number }): string =>
  file.state === "untrusted"
    ? "not trusted"
    : file.state === "changed"
      ? "changed since trusted"
      : file.state === "absent"
        ? "absent"
        : counted(file.settings)

const fileRows = (view: ConfigView): ReadonlyArray<ReadonlyArray<string>> =>
  fileStates(view).map((file) => [file.layer, tilde(file.path, view.home), stateText(file)])

const credentialSet = (environment: Environment, name: string): boolean =>
  (environment[name] ?? "").trim().length > 0

const atDefault = (view: ConfigView): ReadonlyArray<SettingFacts> =>
  view.loaded.resolution.facts.filter((fact) => !view.loaded.resolution.settings.has(fact.name))

/** Pure: the files, every setting some layer sets, credentials, warnings, the default count. */
export const renderShow = (view: ConfigView, options: { readonly all: boolean }): string => {
  const { resolution } = view.loaded
  const lines: Array<string> = ["files", ...table(fileRows(view), "  ")]
  if (resolution.settings.size > 0) {
    lines.push(
      "",
      ...table([
        ["setting", "value", "from"],
        ...[...resolution.settings.values()].map((setting) => {
          const below = setting.shadowed[0]
          return [
            setting.name,
            shown(setting.raw, setting.secret),
            sourceLabel(setting.source),
            ...(below === undefined
              ? []
              : [
                  setting.secret
                    ? `(${sourceLabel(below.source)} sets it too)`
                    : `(${sourceLabel(below.source)} has ${shown(below.raw, false)})`
                ])
          ]
        })
      ])
    )
  }
  lines.push(
    "",
    "credentials",
    ...table(
      foreignCredentials.map((name) => [
        name,
        credentialSet(view.environment, name) ? "set" : "unset"
      ]),
      "  "
    )
  )
  const warnings = resolution.problems.filter((problem) => problem.kind !== "shadowed")
  if (warnings.length > 0) {
    lines.push("", "warnings", ...warnings.map((problem) => `  ${problem.message}`))
  }
  const defaults = atDefault(view)
  if (options.all) {
    for (const [group, title] of groupTitles) {
      const rows = defaults.filter((fact) => fact.group === group)
      if (rows.length > 0) {
        lines.push(
          "",
          title,
          ...table(
            rows.map((fact) => [fact.name, fact.fallback.text, "default"]),
            "  "
          )
        )
      }
    }
  }
  lines.push(
    "",
    options.all
      ? `${counted(defaults.length)} at their defaults · one in full: llm4ts config show <NAME>`
      : `${counted(defaults.length)} at their defaults: llm4ts config show --all · one in full: llm4ts config show <NAME>`
  )
  return lines.join("\n")
}

const belongsIn = {
  global: "the global file",
  project: "the project file",
  run: "a run (llm4ts run --set)",
  secret: "the environment only",
  internal: "nowhere: llm4ts sets it"
}

/** Pure: one setting in full: each layer, the default, its doc, grammar and home. */
export const renderSetting = (view: ConfigView, name: SettingName): string => {
  const fact = facts.get(name)
  const setting = view.loaded.resolution.settings.get(name)
  const secret = fact?.scope === "secret"
  const layers: ReadonlyArray<Layered> = setting === undefined ? [] : [setting, ...setting.shadowed]
  const valueAt = (layer: Source["layer"]): string => {
    const found = layers.find((layered) => layered.source.layer === layer)
    return found === undefined ? "—" : shown(found.raw, secret)
  }
  const where = (source: Source): string =>
    source.layer === "flag"
      ? source.flag
      : source.layer === "environment"
        ? "the environment"
        : `${source.layer} ${tilde(source.path, view.home)}:${source.line}`
  return [
    setting === undefined
      ? `${name} is at its default`
      : `${name} = ${shown(setting.raw, secret)}    from ${where(setting.source)}`,
    ...table(
      [
        ["flag", valueAt("flag")],
        ["environment", valueAt("environment")],
        ["project", valueAt("project")],
        ["global", valueAt("global")],
        ["default", fact?.fallback.text ?? ""]
      ],
      "  "
    ),
    fact?.doc ?? "",
    [
      `value: ${fact?.grammar ?? ""}`,
      `belongs in: ${fact === undefined ? "" : belongsIn[fact.scope]}`,
      `group: ${fact?.group ?? ""}`,
      ...(fact?.flag === undefined ? [] : [`flag: ${fact.flag}`]),
      ...(fact === undefined || fact.requiredBy.length === 0
        ? []
        : [`required by: ${fact.requiredBy.join(", ")}`])
    ].join(" · ")
  ].join("\n")
}

const layerJson = (layered: Layered, secret: boolean) => ({
  source: layered.source.layer,
  ...(layered.source.layer === "project" || layered.source.layer === "global"
    ? { path: layered.source.path, line: layered.source.line }
    : {}),
  ...(layered.source.layer === "flag" ? { flag: layered.source.flag } : {}),
  ...(secret ? {} : { value: layered.raw })
})

/** Pure: every setting, set or not, as JSON. A secret carries `set`, never a value. */
export const renderShowJson = (view: ConfigView): string => {
  const { resolution } = view.loaded
  return JSON.stringify(
    {
      files: fileStates(view),
      settings: resolution.facts.map((fact) => {
        const setting = resolution.settings.get(fact.name)
        const secret = fact.scope === "secret"
        return {
          name: fact.name,
          group: fact.group,
          scope: fact.scope,
          set: setting !== undefined,
          ...(setting === undefined
            ? { source: "default" }
            : {
                ...layerJson(setting, secret),
                shadowed: setting.shadowed.map((layered) => layerJson(layered, secret))
              }),
          default: fact.fallback.text,
          grammar: fact.grammar,
          doc: fact.doc
        }
      }),
      credentials: foreignCredentials.map((name) => ({
        name,
        set: credentialSet(view.environment, name)
      })),
      problems: resolution.problems.map((problem) => ({
        severity: problem.severity,
        kind: problem.kind,
        message: problem.message,
        ...(problem.name === undefined ? {} : { name: problem.name }),
        ...(problem.closest === undefined ? {} : { closest: problem.closest })
      }))
    },
    undefined,
    2
  )
}

/**
 * Pure: doctor's section: both files, how many settings each supplies, what
 * blocks a run: every error, and a project file that is not trusted.
 */
export const renderDoctorConfig = (view: ConfigView): string =>
  [
    "config:",
    ...table(
      fileStates(view).map((file) => [
        file.state === "present" ? "✔" : file.state === "absent" ? "·" : "✖",
        file.layer,
        tilde(file.path, view.home),
        stateText(file)
      ]),
      "  "
    ),
    ...view.loaded.resolution.problems
      .filter((problem) => problem.severity === "error" || problem.kind === "untrusted")
      .map((problem) => `  ✖ ${problem.message}`)
  ].join("\n")

export interface FileChanges {
  readonly layer: FileLayer
  readonly path: string
  /** A line and what happened to it: `new`, `changed`, `unchanged`, `removed (was 2)`. */
  readonly rows: ReadonlyArray<readonly [string, string]>
}

/** Pure: per file, each line `set`, `unset` or `init` touched; then the notes. */
export const renderChanges = (
  files: ReadonlyArray<FileChanges>,
  notes: ReadonlyArray<string>,
  home: string
): string =>
  [
    ...files.flatMap((file) => [
      `${file.layer.padEnd(7)}  ${tilde(file.path, home)}`,
      ...table(file.rows, "  ")
    ]),
    ...notes
  ].join("\n")

/** `NAME=value` split at the first `=`. The failure never repeats the argument: it may hold a secret. */
export const parseAssignment = (
  text: string
): Result.Result<{ readonly name: string; readonly value: string }, string> => {
  const at = text.indexOf("=")
  return at <= 0
    ? Result.fail(
        at < 0
          ? "expected NAME=value, got an argument with no ="
          : "expected NAME=value, got a value with no name"
      )
    : Result.succeed({ name: text.slice(0, at).trim(), value: text.slice(at + 1) })
}

const lastValue = (file: ConfigFile | undefined, name: string): string | undefined => {
  let value: string | undefined
  for (const line of file?.lines ?? []) {
    if (line._tag === "Entry" && line.name === name) {
      value = line.value
    }
  }
  return value
}

/** The settings whose value is passed to a coding agent's command line. */
export const seatFlagSettings: ReadonlyArray<SettingName> = [
  "LLM4TS_CODER_FLAGS",
  "LLM4TS_REASONING_FLAGS"
]

// A file under review is not the user's yet: a control or direction
// character in it could repaint the terminal and hide a line.
const visible = (text: string): string =>
  text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`
  )

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? `1 ${one}` : `${count} ${many}`

/**
 * Pure: what `config trust` asks the user to accept: the file's path, every
 * setting line with its value, tagged when llm4ts runs the value as a
 * command or hands it to a coding agent as flags, and every line the parser
 * rejects. A secret's value is not printed.
 */
export const renderTrustListing = (text: string, projectPath: string): string => {
  const raw = text.split("\n")
  const file = parseConfigFile(text, projectPath)
  const rows = file.lines.flatMap((line): ReadonlyArray<ReadonlyArray<string>> => {
    if (line._tag === "Other") {
      return []
    }
    if (line._tag === "Malformed") {
      return [
        [
          `line ${line.line}`,
          visible((raw[line.line - 1] ?? "").trim()),
          "[rejected: not a NAME=value line]"
        ]
      ]
    }
    const fact = facts.get(line.name)
    const tag =
      fact === undefined
        ? "[not a setting: ignored]"
        : fact.scope === "secret"
          ? "[a secret: ignored in a file]"
          : fact.runs
            ? "[runs as a command]"
            : seatFlagSettings.includes(fact.name)
              ? "[flags for a coding agent]"
              : ""
    return [
      [
        line.name,
        fact?.scope === "secret"
          ? "(value hidden)"
          : line.value.length === 0
            ? "(empty)"
            : visible(line.value),
        tag
      ]
    ]
  })
  const entries = file.lines.filter((line) => line._tag === "Entry")
  const running = entries.filter((line) => facts.get(line.name)?.runs === true).length
  return [
    `project file  ${projectPath}`,
    ...table(rows, "  "),
    rows.length === 0
      ? "it sets nothing"
      : `${plural(entries.length, "setting", "settings")}; llm4ts runs ${plural(running, "value", "values")} as a command`
  ].join("\n")
}

const distrustOf = (loaded: LoadedConfig): Distrust | undefined =>
  loaded.projectTrust === "untrusted" || loaded.projectTrust === "changed"
    ? loaded.projectTrust
    : undefined

const projectRefusal = (view: ConfigView): string | undefined => {
  const distrust = distrustOf(view.loaded)
  return distrust === undefined ? undefined : writeRefusal(view.projectPath, view.repo, distrust)
}

export interface ConfigDeps {
  readonly files: PlainFileStoreShape
  readonly executor: ProcessExecutorShape
  readonly environment: Environment
  readonly cwd: string
}

const usage = (message: string): ShellUsageError => new ShellUsageError({ message })

const viewOf = Effect.fn("@llm4ts/shell/ConfigCommand.viewOf")(function* (
  deps: ConfigDeps,
  repo: string
): Effect.fn.Return<ConfigView, ShellUsageError> {
  const loaded = yield* loadConfig({
    repo,
    environment: deps.environment,
    flags: [],
    files: deps.files
  }).pipe(Effect.mapError((error) => usage(error.message)))
  return {
    loaded,
    environment: deps.environment,
    globalPath: globalConfigPath(deps.environment),
    projectPath: projectConfigPath(repo),
    repo,
    home: homeOf(deps.environment)
  }
})

/** The view `doctor` and `config show` render, for `repo`. */
export const configView = viewOf

const readParsed = (deps: ConfigDeps, path: string) =>
  deps.files.read(path).pipe(
    Effect.map((text) => (text === undefined ? undefined : parseConfigFile(text, path))),
    Effect.mapError((error) => usage(`cannot read ${path}: ${error.message}`))
  )

const pathOf = (view: ConfigView, layer: FileLayer): string =>
  layer === "project" ? view.projectPath : view.globalPath

const trust = (deps: ConfigDeps, repo: string, hash: string) =>
  recordTrust(deps.files, configTrustPath(deps.environment), repo, hash).pipe(
    Effect.mapError((error) => usage(`cannot record trust: ${error.message}`))
  )

/**
 * Writing is trusting: what llm4ts writes to the project file on the user's
 * word is recorded as trusted. The write goes through only while the file
 * still holds the content `view` judged.
 */
const write = Effect.fn("@llm4ts/shell/ConfigCommand.write")(function* (
  deps: ConfigDeps,
  view: ConfigView,
  layer: FileLayer,
  changes: ReadonlyArray<ConfigChange>
): Effect.fn.Return<void, ShellUsageError> {
  const written = yield* writeConfig({
    files: deps.files,
    path: pathOf(view, layer),
    changes,
    ...(layer === "project" ? { expect: { hash: view.loaded.projectHash } } : {})
  }).pipe(Effect.mapError((error) => usage(error.message)))
  if (layer === "project" && written !== undefined) {
    yield* trust(deps, view.repo, contentHash(written))
  }
})

const fileLayers: ReadonlyArray<FileLayer> = ["project", "global"]

/** A path value made absolute the way `config set` writes it. */
const assignmentOf = (
  deps: ConfigDeps,
  name: string,
  value: string
): { readonly name: string; readonly value: string } => ({
  name,
  value:
    facts.get(name)?.path === true && value.trim().length > 0
      ? expandPath(value, deps.cwd, homeOf(deps.environment))
      : value
})

export const runConfigShow = Effect.fn("@llm4ts/shell/ConfigCommand.show")(function* (
  deps: ConfigDeps,
  options: {
    readonly repo: string
    readonly name?: string
    readonly all: boolean
    readonly json: boolean
  }
): Effect.fn.Return<string, ShellUsageError> {
  const view = yield* viewOf(deps, options.repo)
  if (options.name === undefined) {
    return options.json ? renderShowJson(view) : renderShow(view, { all: options.all })
  }
  if (!isSettingName(options.name)) {
    const closest = closestSettingName(options.name)
    return yield* usage(
      closest === undefined
        ? `unknown setting ${options.name}`
        : `unknown setting ${options.name}; did you mean ${closest}?`
    )
  }
  return renderSetting(view, options.name)
})

export const runConfigSet = Effect.fn("@llm4ts/shell/ConfigCommand.set")(function* (
  deps: ConfigDeps,
  options: {
    readonly repo: string
    readonly pairs: ReadonlyArray<string>
    readonly target?: FileLayer
  }
): Effect.fn.Return<string, ShellUsageError> {
  if (options.pairs.length === 0) {
    return yield* usage("config set needs NAME=value")
  }
  const home = homeOf(deps.environment)
  const parsed = options.pairs.map(parseAssignment)
  const malformed = parsed.flatMap((pair) => (Result.isFailure(pair) ? [pair.failure] : []))
  if (malformed.length > 0) {
    return yield* usage(malformed.join("\n"))
  }
  const assignments = parsed
    .flatMap((pair) => (Result.isSuccess(pair) ? [pair.success] : []))
    .map(({ name, value }) => assignmentOf(deps, name, value))
  const planned = planSet(registryFacts, assignments, options.target)
  if (Result.isFailure(planned)) {
    return yield* usage(planned.failure.join("\n"))
  }
  const view = yield* viewOf(deps, options.repo)
  const refusal = projectRefusal(view)
  if (refusal !== undefined && planned.success.some((set) => set.target === "project")) {
    return yield* usage(refusal)
  }
  const reports: Array<FileChanges> = []
  for (const layer of fileLayers) {
    const sets = planned.success.filter((set) => set.target === layer)
    if (sets.length === 0) {
      continue
    }
    const path = pathOf(view, layer)
    const before = yield* readParsed(deps, path)
    reports.push({
      layer,
      path,
      rows: sets.map((set) => {
        const current = lastValue(before, set.name)
        return [
          `${set.name}=${set.value}`,
          current === undefined ? "new" : current === set.value ? "unchanged" : "changed"
        ]
      })
    })
    yield* write(deps, view, layer, sets)
  }
  const after = yield* viewOf(deps, options.repo)
  const written = new Set<string>(planned.success.map((set) => set.name))
  return renderChanges(
    reports,
    after.loaded.resolution.problems
      .filter(
        (problem) =>
          problem.kind === "shadowed" && problem.name !== undefined && written.has(problem.name)
      )
      .map(
        (problem) =>
          `note: ${problem.name} is also exported in this shell, which wins over the file`
      ),
    home
  )
})

export const runConfigUnset = Effect.fn("@llm4ts/shell/ConfigCommand.unset")(function* (
  deps: ConfigDeps,
  options: {
    readonly repo: string
    readonly names: ReadonlyArray<string>
    readonly target?: FileLayer
  }
): Effect.fn.Return<string, ShellUsageError> {
  if (options.names.length === 0) {
    return yield* usage("config unset needs a setting name")
  }
  const view = yield* viewOf(deps, options.repo)
  const refusal = projectRefusal(view)
  if (refusal !== undefined && options.target === "project") {
    return yield* usage(refusal)
  }
  const layers = (options.target === undefined ? fileLayers : [options.target]).filter(
    (layer) => layer !== "project" || refusal === undefined
  )
  const reports: Array<FileChanges> = []
  const found = new Set<string>()
  for (const layer of layers) {
    const path = pathOf(view, layer)
    const before = yield* readParsed(deps, path)
    const held = options.names.flatMap((name): ReadonlyArray<readonly [string, string]> => {
      const current = lastValue(before, name)
      if (current === undefined) {
        return []
      }
      const scope = facts.get(name)?.scope
      return [
        [name, scope === "global" || scope === "project" ? `removed (was ${current})` : "removed"]
      ]
    })
    if (held.length === 0) {
      continue
    }
    for (const [name] of held) {
      found.add(name)
    }
    reports.push({ layer, path, rows: held })
    yield* write(
      deps,
      view,
      layer,
      held.map(([name]) => ({ name, value: undefined }))
    )
  }
  return renderChanges(
    reports,
    [
      ...options.names
        .filter((name) => !found.has(name))
        .map((name) => {
          const closest = isSettingName(name) ? undefined : closestSettingName(name)
          return closest === undefined
            ? `${name} is not set in a config file`
            : `${name} is not set in a config file; did you mean ${closest}?`
        }),
      ...(refusal === undefined ? [] : [`left alone: ${refusal}`])
    ],
    view.home
  )
})

export type SeatAnswers = ReadonlyArray<{ readonly name: SettingName; readonly value: string }>

export interface InitWrite {
  readonly layer: FileLayer
  readonly name: SettingName
  readonly value: string
  readonly origin: "environment" | "answer"
}

export interface InitPlan {
  readonly writes: ReadonlyArray<InitWrite>
  readonly skipped: ReadonlyArray<string>
  /** Exports a file now covers with the same value. */
  readonly removable: ReadonlyArray<string>
}

/**
 * Pure: what `config init` writes. Every `LLM4TS_*` the environment sets goes
 * to the file its scope belongs in unless that file already has a line for
 * it; run-scoped, secret, internal, unreadable and unknown names are skipped
 * with the reason, and so is a project setting while the project file is not
 * trusted. `answers` fill only names nothing sets yet.
 */
export const planInit = (input: {
  readonly environment: Environment
  readonly global: ConfigFile | undefined
  readonly project: ConfigFile | undefined
  /** Why nothing may be written to the project file; absent when it may. */
  readonly projectRefusal?: string
  readonly cwd: string
  readonly home: string
  readonly answers: SeatAnswers
}): InitPlan => {
  const writes: Array<InitWrite> = []
  const skipped: Array<string> = []
  const removable: Array<string> = []
  const fileOf = (layer: FileLayer) => (layer === "project" ? input.project : input.global)
  for (const fact of registryFacts) {
    const raw = input.environment[fact.name]
    if (raw === undefined) {
      continue
    }
    const read = readSetting(fact.name, raw)
    if (Result.isSuccess(read) && read.success === undefined) {
      continue
    }
    const value = fact.path ? expandPath(raw, input.cwd, input.home) : raw
    const planned = planSet(registryFacts, [{ name: fact.name, value }])
    const [set] = Result.isSuccess(planned) ? planned.success : []
    if (set === undefined) {
      skipped.push(`skipped ${Result.isFailure(planned) ? planned.failure.join("; ") : fact.name}`)
      continue
    }
    if (set.target === "project" && input.projectRefusal !== undefined) {
      skipped.push(`skipped ${fact.name}: ${input.projectRefusal}`)
      continue
    }
    const current = lastValue(fileOf(set.target), fact.name)
    if (current === undefined) {
      writes.push({ layer: set.target, name: fact.name, value, origin: "environment" })
      removable.push(fact.name)
    } else if (current === value) {
      removable.push(fact.name)
    } else {
      skipped.push(`kept ${fact.name}: the ${set.target} file already sets another value`)
    }
  }
  for (const name of Object.keys(input.environment).sort()) {
    if (
      name.startsWith("LLM4TS_") &&
      !isSettingName(name) &&
      input.environment[name] !== undefined
    ) {
      const closest = closestSettingName(name)
      skipped.push(
        closest === undefined
          ? `skipped ${name}: not a setting`
          : `skipped ${name}: not a setting; did you mean ${closest}?`
      )
    }
  }
  for (const answer of input.answers) {
    const layer = facts.get(answer.name)?.scope
    if (
      (layer === "global" || layer === "project") &&
      !writes.some((write) => write.name === answer.name) &&
      lastValue(fileOf(layer), answer.name) === undefined &&
      input.environment[answer.name] === undefined
    ) {
      writes.push({ layer, name: answer.name, value: answer.value, origin: "answer" })
    }
  }
  return { writes, skipped, removable }
}

/** Pure: what `init` wrote per file, what it skipped, and which exports can go. */
export const renderInit = (
  plan: InitPlan,
  paths: { readonly global: string; readonly project: string; readonly home: string }
): string => {
  const lines = fileLayers.flatMap((layer) => {
    const writes = plan.writes.filter((write) => write.layer === layer)
    return writes.length === 0
      ? []
      : [
          `wrote ${tilde(layer === "project" ? paths.project : paths.global, paths.home)} (${layer})`,
          ...table(
            writes.map((write) => [
              `${write.name}=${write.value}`,
              ...(write.origin === "environment" ? ["from the environment"] : [])
            ]),
            "  "
          )
        ]
  })
  return [
    ...lines,
    ...plan.skipped,
    ...(plan.writes.length === 0
      ? ["nothing to do: the config files hold every setting the environment sets"]
      : []),
    ...(plan.removable.length === 0
      ? []
      : [`these exports can now go from your shell profile: ${plan.removable.join(" ")}`]),
    ...(plan.writes.length === 0 ? [] : ["check: llm4ts config show"])
  ].join("\n")
}

export const runConfigInit = Effect.fn("@llm4ts/shell/ConfigCommand.init")(function* <
  E = never,
  R = never
>(
  deps: ConfigDeps,
  options: {
    readonly repo: string
    /** Asked only when there is no global file yet; absent off a terminal. */
    readonly ask?: Effect.Effect<SeatAnswers, E, R>
  }
): Effect.fn.Return<string, ShellUsageError | E, R> {
  const view = yield* viewOf(deps, options.repo)
  const answers =
    view.loaded.global === undefined && options.ask !== undefined ? yield* options.ask : []
  const refusal = projectRefusal(view)
  const plan = planInit({
    environment: deps.environment,
    global: view.loaded.global,
    project: view.loaded.project,
    ...(refusal === undefined ? {} : { projectRefusal: refusal }),
    cwd: deps.cwd,
    home: view.home,
    answers
  })
  for (const layer of fileLayers) {
    const changes = plan.writes.filter((entry) => entry.layer === layer)
    if (changes.length > 0) {
      yield* write(deps, view, layer, changes)
    }
  }
  return renderInit(plan, {
    global: view.globalPath,
    project: view.projectPath,
    home: view.home
  })
})

export type ProjectReview =
  | { readonly _tag: "Absent"; readonly projectPath: string }
  | { readonly _tag: "Trusted"; readonly projectPath: string }
  | {
      readonly _tag: "Pending"
      readonly projectPath: string
      readonly repo: string
      /** The hash of the text `listing` was rendered from: what accepting records. */
      readonly hash: string
      readonly listing: string
    }

/** Reads the project file of `repo` once: how it stands, and what there is to accept. */
export const reviewProject = Effect.fn("@llm4ts/shell/ConfigCommand.reviewProject")(function* (
  deps: ConfigDeps,
  repo: string
): Effect.fn.Return<ProjectReview, ShellUsageError> {
  const projectPath = projectConfigPath(repo)
  const text = yield* deps.files
    .read(projectPath)
    .pipe(Effect.mapError((error) => usage(`cannot read ${projectPath}: ${error.message}`)))
  if (text === undefined) {
    return { _tag: "Absent", projectPath }
  }
  const hash = contentHash(text)
  const store = yield* loadTrustStore(deps.files, configTrustPath(deps.environment))
  return trustDecision(store, repo, hash) === "trusted"
    ? { _tag: "Trusted", projectPath }
    : { _tag: "Pending", projectPath, repo, hash, listing: renderTrustListing(text, projectPath) }
})

/** Records the reviewed content as trusted; the line that says so. */
export const acceptProject = Effect.fn("@llm4ts/shell/ConfigCommand.acceptProject")(function* (
  deps: ConfigDeps,
  review: Extract<ProjectReview, { readonly _tag: "Pending" }>
): Effect.fn.Return<string, ShellUsageError> {
  yield* trust(deps, review.repo, review.hash)
  return `trusted: ${review.projectPath} (llm4ts reads it until its content changes)`
})

export type TrustStep =
  | { readonly kind: "done"; readonly line: string }
  | { readonly kind: "record" }
  | { readonly kind: "ask" }
  | { readonly kind: "refuse"; readonly line: string }

/** Pure: what `config trust` does with a review: nothing, record, ask, or stop unrecorded. */
export const trustStep = (
  review: ProjectReview,
  options: { readonly yes: boolean; readonly interactive: boolean }
): TrustStep =>
  review._tag === "Absent"
    ? { kind: "done", line: `no project file at ${review.projectPath}: nothing to trust` }
    : review._tag === "Trusted"
      ? { kind: "done", line: `${review.projectPath} is already trusted` }
      : options.yes
        ? { kind: "record" }
        : options.interactive
          ? { kind: "ask" }
          : {
              kind: "refuse",
              line: `not recorded: review the listing, then ${trustCommand(review.repo)} --yes, or answer on a terminal`
            }

export const trustQuestion = "Trust this file? llm4ts will read it, and run what it says to run"

export const declinedLine = "not trusted: nothing was recorded"

export const runConfigUntrust = Effect.fn("@llm4ts/shell/ConfigCommand.untrust")(function* (
  deps: ConfigDeps,
  options: { readonly repo: string }
): Effect.fn.Return<string, ShellUsageError> {
  const removed = yield* forgetTrust(
    deps.files,
    configTrustPath(deps.environment),
    options.repo
  ).pipe(Effect.mapError((error) => usage(`cannot record trust: ${error.message}`)))
  const projectPath = projectConfigPath(options.repo)
  return removed
    ? `no longer trusted: ${projectPath}`
    : `${projectPath} was not trusted: nothing to remove`
})

const seatChoices = (environment: Environment): Array<Prompt.SelectChoice<string>> =>
  coderChoices.map((choice) => ({
    title:
      findOnPath(choice.executable, environment) === undefined
        ? choice.token
        : `${choice.token} ✓ found`,
    value: choice.token
  }))

const askSeats = (environment: Environment) =>
  Effect.gen(function* () {
    const coder = yield* Prompt.run(
      Prompt.Select({
        message: "Which coding agent edits files?",
        choices: seatChoices(environment)
      })
    )
    const reasoner = yield* Prompt.run(
      Prompt.Select({
        message: "Which agent plans, reviews and judges?",
        choices: seatChoices(environment)
      })
    )
    const answers: SeatAnswers = [
      { name: "LLM4TS_CODER", value: coder },
      { name: "LLM4TS_REASONER", value: reasoner }
    ]
    return answers
  })

const onTerminal = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true

const nodeDeps = (): ConfigDeps => ({
  files: nodePlainFileStore,
  executor: nodeProcessExecutor,
  environment: process.env,
  cwd: process.cwd()
})

const repoFlag = Flag.String("repo").pipe(
  Flag.optional,
  Flag.withDescription(
    "Repository whose .llm4ts/config.env is the project file (defaults to the current directory)"
  )
)

const repoOf = (
  repo: { readonly _tag: "Some"; readonly value: string } | { readonly _tag: "None" }
) => resolve(repo._tag === "Some" ? repo.value : process.cwd())

const targetFlags = {
  global: Flag.Boolean("global").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Use the global file, whatever file the setting belongs in")
  ),
  project: Flag.Boolean("project").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Use the project file, whatever file the setting belongs in")
  )
}

const targetOf = (flags: {
  readonly global: boolean
  readonly project: boolean
}): Effect.Effect<FileLayer | undefined, ShellUsageError> =>
  flags.global && flags.project
    ? Effect.fail(usage("use --global or --project, not both"))
    : Effect.succeed(flags.global ? "global" : flags.project ? "project" : undefined)

const showCommand = Command.make(
  "show",
  {
    name: Argument.String("name").pipe(
      Argument.optional,
      Argument.withDescription("One setting in full: each layer, its doc and grammar")
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Also list every setting at its default, by group")
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Every setting as JSON")
    ),
    repo: repoFlag
  },
  (config) =>
    Effect.gen(function* () {
      yield* Console.log(
        yield* runConfigShow(nodeDeps(), {
          repo: repoOf(config.repo),
          ...(config.name._tag === "Some" ? { name: config.name.value } : {}),
          all: config.all,
          json: config.json
        })
      )
    })
).pipe(Command.withDescription("Each setting's effective value and where it comes from"))

const setCommand = Command.make(
  "set",
  {
    pairs: Argument.String("NAME=value").pipe(
      Argument.variadic(),
      Argument.withDescription("Settings to write, each to the file it belongs in")
    ),
    ...targetFlags,
    repo: repoFlag
  },
  (config) =>
    Effect.gen(function* () {
      const target = yield* targetOf(config)
      yield* Console.log(
        yield* runConfigSet(nodeDeps(), {
          repo: repoOf(config.repo),
          pairs: config.pairs,
          ...(target === undefined ? {} : { target })
        })
      )
    })
).pipe(
  Command.withDescription(
    "Write settings to the config files; every pair is checked before anything is written"
  )
)

const unsetCommand = Command.make(
  "unset",
  {
    names: Argument.String("NAME").pipe(
      Argument.variadic(),
      Argument.withDescription("Settings to remove from the config files")
    ),
    ...targetFlags,
    repo: repoFlag
  },
  (config) =>
    Effect.gen(function* () {
      const target = yield* targetOf(config)
      yield* Console.log(
        yield* runConfigUnset(nodeDeps(), {
          repo: repoOf(config.repo),
          names: config.names,
          ...(target === undefined ? {} : { target })
        })
      )
    })
).pipe(Command.withDescription("Remove settings from the config files"))

const initCommand = Command.make("init", { repo: repoFlag }, (config) =>
  Effect.gen(function* () {
    const deps = nodeDeps()
    const interactive = onTerminal()
    yield* Console.log(
      yield* runConfigInit(deps, {
        repo: repoOf(config.repo),
        ...(interactive ? { ask: askSeats(deps.environment) } : {})
      })
    )
  })
).pipe(
  Command.withDescription(
    "Write the LLM4TS_* settings the environment exports into the config files; on a new machine, ask coder and reasoner first"
  )
)

const insideRepository = (deps: ConfigDeps, repo: string): Effect.Effect<boolean> =>
  deps.executor.run(["git", "rev-parse", "--is-inside-work-tree"], repo, {}).pipe(
    Effect.map((result) => result.exitCode === 0),
    Effect.orElseSucceed(() => false)
  )

const heldIn = (view: ConfigView, name: SettingName): ReadonlyArray<FileLayer> =>
  fileLayers.filter(
    (layer) =>
      lastValue(layer === "project" ? view.loaded.project : view.loaded.global, name) !== undefined
  )

const backChoice = { title: "back", value: undefined }

const askText = (deps: ConfigDeps, fact: SettingFacts, current: string | undefined) =>
  Prompt.run(
    Prompt.String({
      message:
        current === undefined
          ? `${fact.name} (${fact.grammar}; empty cancels)`
          : `${fact.name} (${fact.grammar}; Tab takes the current value, empty cancels)`,
      ...(current === undefined ? {} : { default: current }),
      validate: (answer) => {
        const value = answer.trim()
        if (value.length === 0) {
          return Effect.succeed("")
        }
        const planned = planSet(registryFacts, [assignmentOf(deps, fact.name, value)])
        return Result.isFailure(planned)
          ? Effect.fail(planned.failure.join("; "))
          : Effect.succeed(value)
      }
    })
  ).pipe(Effect.map((value) => (value.length === 0 ? undefined : value)))

/** The new value, or `undefined` when the question was left unanswered. */
const askValue = (deps: ConfigDeps, fact: SettingFacts, current: string | undefined) => {
  const asked = valuePrompt(fact)
  const select = (choices: ReadonlyArray<Prompt.SelectChoice<string | undefined>>) =>
    Prompt.run(Prompt.Select({ message: `${fact.name} (${fact.grammar})`, choices }))
  switch (asked.kind) {
    case "toggle": {
      return select([{ title: "on", value: "on" }, { title: "off", value: "off" }, backChoice])
    }
    case "choices": {
      return select([
        ...asked.choices.map((choice) => ({ title: choice, value: choice })),
        backChoice
      ])
    }
    case "seat": {
      return Effect.flatMap(
        select([
          ...seatChoices(deps.environment),
          { title: "another name, typed", value: "" },
          backChoice
        ]),
        (choice) => (choice === "" ? askText(deps, fact, current) : Effect.succeed(choice))
      )
    }
    case "text": {
      return askText(deps, fact, current)
    }
  }
}

const editSetting = Effect.fn("@llm4ts/shell/ConfigCommand.editSetting")(function* (
  deps: ConfigDeps,
  options: { readonly repo: string; readonly inRepository: boolean },
  fact: SettingFacts,
  record: (change: SessionChange) => void
) {
  const view = yield* viewOf(deps, options.repo)
  const held = heldIn(view, fact.name)
  const fileValue = (within: ConfigView, layer: FileLayer): string | undefined =>
    lastValue(layer === "project" ? within.loaded.project : within.loaded.global, fact.name)
  const note = environmentNote(view.loaded.resolution, fact.name)
  yield* Console.log(
    ["", renderSetting(view, fact.name), ...(note === undefined ? [] : [note]), ""].join("\n")
  )
  const action = yield* Prompt.run(
    Prompt.Select<SettingAction>({
      message: fact.name,
      choices: settingActions(held).map((choice) => ({ title: choice.title, value: choice.action }))
    })
  )
  if (action.kind === "back") {
    return
  }
  if (action.kind === "remove") {
    yield* Console.log(
      yield* runConfigUnset(deps, { repo: options.repo, names: [fact.name], target: action.layer })
    )
    record({ name: fact.name, layer: action.layer, kind: "removed" })
    return
  }
  const first = held[0]
  const value = yield* askValue(
    deps,
    fact,
    first === undefined ? undefined : fileValue(view, first)
  )
  if (value === undefined) {
    yield* Console.log(`${fact.name} left as it was`)
    return
  }
  const targets = saveTargets(fact, {
    inRepository: options.inRepository,
    projectRefused: distrustOf(view.loaded) !== undefined,
    held
  })
  const [only = "global", ...others] = targets
  const target =
    others.length === 0
      ? only
      : yield* Prompt.run(
          Prompt.Select<FileLayer>({
            message: "Save it for",
            choices: targets.map((layer) => ({ title: targetTitles[layer], value: layer }))
          })
        )
  yield* Console.log(
    yield* runConfigSet(deps, { repo: options.repo, pairs: [`${fact.name}=${value}`], target })
  )
  const after = yield* viewOf(deps, options.repo)
  if (fileValue(after, target) !== fileValue(view, target)) {
    record({ name: fact.name, layer: target, kind: "set" })
  }
})

/**
 * The guided editor: pick a setting, see it in full, change or remove it,
 * back to the list. `name` opens that one setting and ends after it. Ends on
 * "done" or Ctrl-C with one line on what the session changed.
 */
export const editSession = Effect.fn("@llm4ts/shell/ConfigCommand.editSession")(function* (
  deps: ConfigDeps,
  options: { readonly repo: string; readonly name?: SettingName }
) {
  const changes: Array<SessionChange> = []
  const record = (change: SessionChange): void => {
    changes.push(change)
  }
  const inRepository = yield* insideRepository(deps, options.repo)
  const review = yield* reviewProject(deps, options.repo)
  if (review._tag === "Pending") {
    yield* Console.log(review.listing)
    const accepted = yield* Prompt.run(
      Prompt.Confirm({ message: trustQuestion, initial: false })
    ).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)))
    yield* Console.log(
      accepted
        ? yield* acceptProject(deps, review)
        : `${declinedLine}; the editor saves to the global file only, and a save to the project file is refused`
    )
  }
  const pick = Effect.gen(function* () {
    const view = yield* viewOf(deps, options.repo)
    return yield* Prompt.run(
      Prompt.AutoComplete<SettingName | undefined>({
        message: "Which setting?",
        maxPerPage: 12,
        choices: [
          { title: "done", value: undefined, description: "leave the editor" },
          ...pickerRows(view.loaded.resolution).map((row) => ({
            title: row.title,
            value: row.name,
            description: row.description
          }))
        ]
      })
    )
  })
  const open = (name: SettingName) => {
    const fact = facts.get(name)
    return fact === undefined
      ? Effect.void
      : editSetting(deps, { repo: options.repo, inRepository }, fact, record)
  }
  const session =
    options.name === undefined
      ? Effect.gen(function* () {
          yield* Console.log(unlistedHint)
          while (true) {
            const name = yield* pick
            if (name === undefined) {
              return
            }
            yield* open(name).pipe(
              Effect.catchTag("ShellUsage", (error) => Console.error(error.message))
            )
          }
        })
      : open(options.name)
  // Ctrl-C leaves the cursor at the end of the prompt's last line.
  yield* session.pipe(Effect.catchTag("QuitError", () => Console.log("")))
  yield* Console.log(sessionSummary(changes))
})

/** The editor for `repo`, on this process's files and environment. */
export const openConfigEditor = (repo: string) => editSession(nodeDeps(), { repo })

const editCommand = Command.make(
  "edit",
  {
    name: Argument.String("name").pipe(
      Argument.optional,
      Argument.withDescription("Open this setting instead of the list")
    ),
    repo: repoFlag
  },
  (config) =>
    Effect.gen(function* () {
      const request = editRequest(registryFacts, {
        ...(config.name._tag === "Some" ? { name: config.name.value } : {}),
        interactive: onTerminal()
      })
      if (Result.isFailure(request)) {
        return yield* usage(request.failure)
      }
      yield* editSession(nodeDeps(), {
        repo: repoOf(config.repo),
        ...(request.success === undefined ? {} : { name: request.success })
      })
    })
).pipe(
  Command.withDescription(
    "Guided editor on a terminal: pick a setting, see its value and where it comes from, change or remove it"
  )
)

const trustCommandLine = Command.make(
  "trust",
  {
    yes: Flag.Boolean("yes").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Record without asking, after you have read the listing")
    ),
    repo: repoFlag
  },
  (config) =>
    Effect.gen(function* () {
      const deps = nodeDeps()
      const review = yield* reviewProject(deps, repoOf(config.repo))
      const step = trustStep(review, { yes: config.yes, interactive: onTerminal() })
      if (step.kind === "done") {
        return yield* Console.log(step.line)
      }
      if (review._tag !== "Pending") {
        return
      }
      yield* Console.log(review.listing)
      if (step.kind === "refuse") {
        return yield* usage(step.line)
      }
      const accepted =
        step.kind === "record" ||
        (yield* Prompt.run(Prompt.Confirm({ message: trustQuestion, initial: false })).pipe(
          Effect.catchTag("QuitError", () => Effect.succeed(false))
        ))
      yield* Console.log(accepted ? yield* acceptProject(deps, review) : declinedLine)
    })
).pipe(
  Command.withDescription(
    "Review the project file and accept it: llm4ts reads a project file only while its content is the one you trusted"
  )
)

const untrustCommand = Command.make("untrust", { repo: repoFlag }, (config) =>
  Effect.gen(function* () {
    yield* Console.log(yield* runConfigUntrust(nodeDeps(), { repo: repoOf(config.repo) }))
  })
).pipe(Command.withDescription("Forget the trust recorded for this repository's project file"))

export const configCommand = Command.make("config", {}, () =>
  onTerminal()
    ? openConfigEditor(process.cwd())
    : Effect.fail(
        usage(
          "try `llm4ts config show`, `llm4ts config set NAME=value`, `llm4ts config unset NAME`, `llm4ts config init`, `llm4ts config trust`, or `llm4ts config edit` on a terminal"
        )
      )
).pipe(
  Command.withDescription(
    "The config files (~/.config/llm4ts/config.env, <repo>/.llm4ts/config.env): show, set, unset, init, edit, trust, untrust (ADR 0049)"
  ),
  Command.withSubcommands([
    showCommand,
    setCommand,
    unsetCommand,
    initCommand,
    editCommand,
    trustCommandLine,
    untrustCommand
  ])
)
