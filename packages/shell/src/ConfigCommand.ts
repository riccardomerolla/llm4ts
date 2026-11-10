// `llm4ts config show | set | unset | init`: the config files seen and edited
// from the command line. Every renderer is pure and never prints a secret.
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

type FileState = "absent" | "present" | "ignored"

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
    state: view.loaded.projectTracked
      ? "ignored"
      : view.loaded.project === undefined
        ? "absent"
        : "present",
    settings: suppliedBy(view, "project")
  }
]

const stateText = (file: { readonly state: FileState; readonly settings: number }): string =>
  file.state === "ignored"
    ? "ignored (tracked by git)"
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

/** Pure: doctor's section: both files, how many settings each supplies, what blocks a run. */
export const renderDoctorConfig = (view: ConfigView): string =>
  [
    "config:",
    ...table(
      fileStates(view).map((file) => [
        file.state === "present" ? "✔" : file.state === "ignored" ? "✖" : "·",
        file.layer,
        tilde(file.path, view.home),
        stateText(file)
      ]),
      "  "
    ),
    ...view.loaded.resolution.problems
      .filter((problem) => problem.severity === "error")
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

const trackedRefusal = (projectPath: string): string =>
  `${projectPath} is tracked by git, so llm4ts ignores it and writes nothing to it. Untrack it first: git rm --cached .llm4ts/config.env`

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
    files: deps.files,
    executor: deps.executor
  }).pipe(Effect.mapError((error) => usage(error.message)))
  return {
    loaded,
    environment: deps.environment,
    globalPath: globalConfigPath(deps.environment),
    projectPath: projectConfigPath(repo),
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

const write = (deps: ConfigDeps, path: string, changes: ReadonlyArray<ConfigChange>) =>
  writeConfig({ files: deps.files, path, changes }).pipe(
    Effect.mapError((error) => usage(error.message))
  )

const pathOf = (view: ConfigView, layer: FileLayer): string =>
  layer === "project" ? view.projectPath : view.globalPath

const fileLayers: ReadonlyArray<FileLayer> = ["project", "global"]

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
    .map(({ name, value }) => ({
      name,
      value:
        facts.get(name)?.path === true && value.trim().length > 0
          ? expandPath(value, deps.cwd, home)
          : value
    }))
  const planned = planSet(registryFacts, assignments, options.target)
  if (Result.isFailure(planned)) {
    return yield* usage(planned.failure.join("\n"))
  }
  const view = yield* viewOf(deps, options.repo)
  if (view.loaded.projectTracked && planned.success.some((set) => set.target === "project")) {
    return yield* usage(trackedRefusal(view.projectPath))
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
    yield* write(deps, path, sets)
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
  if (view.loaded.projectTracked && options.target === "project") {
    return yield* usage(trackedRefusal(view.projectPath))
  }
  const layers = (options.target === undefined ? fileLayers : [options.target]).filter(
    (layer) => layer !== "project" || !view.loaded.projectTracked
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
      path,
      held.map(([name]) => ({ name, value: undefined }))
    )
  }
  return renderChanges(
    reports,
    options.names
      .filter((name) => !found.has(name))
      .map((name) => {
        const closest = isSettingName(name) ? undefined : closestSettingName(name)
        return closest === undefined
          ? `${name} is not set in a config file`
          : `${name} is not set in a config file; did you mean ${closest}?`
      }),
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
 * with the reason. `answers` fill only names nothing sets yet.
 */
export const planInit = (input: {
  readonly environment: Environment
  readonly global: ConfigFile | undefined
  readonly project: ConfigFile | undefined
  readonly projectTracked: boolean
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
    if (set.target === "project" && input.projectTracked) {
      skipped.push(`skipped ${fact.name}: the project file is tracked by git and ignored`)
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
  const plan = planInit({
    environment: deps.environment,
    global: view.loaded.global,
    project: view.loaded.project,
    projectTracked: view.loaded.projectTracked,
    cwd: deps.cwd,
    home: view.home,
    answers
  })
  for (const layer of fileLayers) {
    const changes = plan.writes.filter((entry) => entry.layer === layer)
    if (changes.length > 0) {
      yield* write(deps, pathOf(view, layer), changes)
    }
  }
  return renderInit(plan, {
    global: view.globalPath,
    project: view.projectPath,
    home: view.home
  })
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
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
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

export const configCommand = Command.make("config", {}, () =>
  Effect.fail(
    usage(
      "try `llm4ts config show`, `llm4ts config set NAME=value`, `llm4ts config unset NAME` or `llm4ts config init`"
    )
  )
).pipe(
  Command.withDescription(
    "The config files (~/.config/llm4ts/config.env, <repo>/.llm4ts/config.env): show, set, unset, init (ADR 0049)"
  ),
  Command.withSubcommands([showCommand, setCommand, unsetCommand, initCommand])
)
