// The config files: the environment, written down. Two dotenv files hold
// `LLM4TS_*` names, one per user and one per clone; `resolveConfig` layers
// them under the process environment and the flags, and `flowEnvironment`
// hands the result to a flow child. No message built here carries a value,
// so a secret cannot leak through one.
import { homedir } from "node:os"
import { basename, extname, isAbsolute, join, resolve } from "node:path"
import * as Brand from "effect/Brand"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { ignoringRunState } from "@llm4ts/flow/RunState"
import {
  closestSettingName,
  readSetting,
  settingFacts,
  settingNames,
  type Environment,
  type SettingFacts,
  type SettingName
} from "@llm4ts/flow/Settings"
import { ShellUsageError } from "./ShellErrors.ts"

export type FileLayer = "project" | "global"

export type Source =
  | { readonly layer: "flag"; readonly flag: string }
  | { readonly layer: "environment" }
  | { readonly layer: FileLayer; readonly path: string; readonly line: number }

export type ProblemSeverity = "error" | "warning" | "note"

export type ProblemKind =
  | "malformed"
  | "unknown"
  | "unreadable"
  | "misplaced"
  | "duplicate"
  | "conflict"
  | "shadowed"
  | "tracked"

export interface ConfigProblem {
  readonly severity: ProblemSeverity
  readonly kind: ProblemKind
  /** Starts with where the problem is; never holds a value. */
  readonly message: string
  readonly name?: string
  /** For an unknown name: the setting it most likely meant. */
  readonly closest?: SettingName
  readonly source?: Source
}

export type ConfigLine =
  | { readonly _tag: "Entry"; readonly line: number; readonly name: string; readonly value: string }
  | { readonly _tag: "Other"; readonly line: number }
  | { readonly _tag: "Malformed"; readonly line: number }

export interface ConfigFile {
  readonly path: string
  readonly lines: ReadonlyArray<ConfigLine>
  readonly problems: ReadonlyArray<ConfigProblem>
}

export interface FlagAssignment {
  readonly name: string
  readonly value: string
  /** The flag that supplied it: `--set`, `--pack`. */
  readonly flag: string
}

/** One layer's value for a setting; a file's path value is already absolute. */
export interface Layered {
  readonly source: Source
  readonly raw: string
}

export interface ResolvedSetting extends Layered {
  readonly name: SettingName
  /** Lower layers that also set it, highest first. */
  readonly shadowed: ReadonlyArray<Layered>
  /** Renderers print "set", never `raw`. */
  readonly secret: boolean
}

export interface Resolution {
  readonly facts: ReadonlyArray<SettingFacts>
  /** Settings some layer sets, in registry order; the rest are at their fallback. */
  readonly settings: ReadonlyMap<SettingName, ResolvedSetting>
  readonly problems: ReadonlyArray<ConfigProblem>
}

export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String
}) {}

/** Every registry entry, in registry order. */
export const registryFacts: ReadonlyArray<SettingFacts> = settingNames.map(settingFacts)

export const homeOf = (environment: Environment): string => environment.HOME ?? homedir()

/** `${XDG_CONFIG_HOME:-~/.config}/llm4ts/config.env`. */
export const globalConfigPath = (environment: Environment): string =>
  join(environment.XDG_CONFIG_HOME ?? join(homeOf(environment), ".config"), "llm4ts", "config.env")

/** `<repo>/.llm4ts/config.env`: local to the clone, above the global file. */
export const projectConfigPath = (repo: string): string => join(repo, ".llm4ts", "config.env")

export const describeSource = (source: Source): string =>
  source.layer === "flag"
    ? source.flag
    : source.layer === "environment"
      ? "the environment"
      : `${source.path}:${source.line}`

type ParsedLine =
  | {
      readonly _tag: "Entry"
      readonly name: string
      readonly value: string
      readonly exported: string
      readonly comment: string
    }
  | { readonly _tag: "Other" }
  | { readonly _tag: "Malformed" }

const entryPattern = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u

const parseValue = (
  rest: string
): { readonly value: string; readonly comment: string } | undefined => {
  const quote = rest[0]
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1)
    if (end < 0) {
      return undefined
    }
    const tail = rest.slice(end + 1)
    return tail.length === 0 || /^\s+#/u.test(tail)
      ? { value: rest.slice(1, end), comment: tail }
      : undefined
  }
  const at = rest.search(/\s#/u)
  const body = at < 0 ? rest : rest.slice(0, at)
  return { value: body.trim(), comment: at < 0 ? "" : rest.slice(body.trimEnd().length) }
}

const parseLine = (text: string): ParsedLine => {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return { _tag: "Other" }
  }
  const match = entryPattern.exec(trimmed)
  const parsed = match === null ? undefined : parseValue(match[3] ?? "")
  return match === null || parsed === undefined
    ? { _tag: "Malformed" }
    : { _tag: "Entry", name: match[2] ?? "", exported: match[1] ?? "", ...parsed }
}

/**
 * The strict dotenv subset: blank, `#` comment, or `[export ]NAME=value[ # comment]`
 * with the value unquoted or wholly quoted. No escapes, no interpolation, no
 * multi-line values; anything else is a malformed line.
 */
export const parseConfigFile = (text: string, path: string): ConfigFile => {
  const rawLines = text.split("\n")
  if (rawLines.at(-1) === "") {
    rawLines.pop()
  }
  const lines = rawLines.map((raw, index): ConfigLine => {
    const parsed = parseLine(raw)
    const line = index + 1
    return parsed._tag === "Entry"
      ? { _tag: "Entry", line, name: parsed.name, value: parsed.value }
      : { _tag: parsed._tag, line }
  })
  return {
    path,
    lines,
    problems: lines
      .filter((line) => line._tag === "Malformed")
      .map(
        (line): ConfigProblem => ({
          severity: "error",
          kind: "malformed",
          message: `${path}:${line.line}: not a NAME=value line`
        })
      )
  }
}

/** A leading `~/` expanded, then made absolute against `base`. */
export const expandPath = (raw: string, base: string, home: string): string => {
  const trimmed = raw.trim()
  if (trimmed === "~") {
    return home
  }
  if (trimmed.startsWith("~/")) {
    return join(home, trimmed.slice(2))
  }
  return isAbsolute(trimmed) ? trimmed : resolve(base, trimmed)
}

const misplacedInFile = {
  run: (name: string) => `is set per run and is ignored in a file; use --set ${name}=<value>`,
  secret: () => "is a secret and is ignored in a file; export it in the environment",
  internal: () => "is set by llm4ts and is ignored in a file"
}

const refusedFromFlag = {
  secret: "is a secret: export it in the environment",
  internal: "is set by llm4ts"
}

const unknownText = (name: string, closest: SettingName | undefined): string =>
  closest === undefined
    ? `unknown setting ${name}`
    : `unknown setting ${name}; did you mean ${closest}?`

const sameValue = (name: SettingName, left: string, right: string): boolean => {
  if (left.trim() === right.trim()) {
    return true
  }
  const [a, b] = [readSetting(name, left), readSetting(name, right)]
  return (
    Result.isSuccess(a) &&
    Result.isSuccess(b) &&
    typeof a.success === "boolean" &&
    a.success === b.success
  )
}

export interface ResolveInput {
  readonly facts: ReadonlyArray<SettingFacts>
  readonly flags: ReadonlyArray<FlagAssignment>
  readonly environment: Environment
  /** `undefined`: the file is absent. */
  readonly project: ConfigFile | undefined
  readonly global: ConfigFile | undefined
  /** Relative paths in the project file resolve against it. */
  readonly repo: string
  /** `~/` and relative paths in the global file resolve against it. */
  readonly home: string
}

/**
 * Pure: flag > environment > project file > global file. Judges each
 * assignment against the registry and keeps what each winner shadows. An
 * empty value counts as unset unless the grammar gives empty a meaning. A
 * value the grammar does not read is dropped from a flag or a file (an
 * error) and kept from the environment (a warning): an export keeps the
 * meaning it has today.
 */
export const resolveConfig = (input: ResolveInput): Resolution => {
  const known = new Map<string, SettingFacts>(input.facts.map((fact) => [fact.name, fact]))
  const problems: Array<ConfigProblem> = []
  const layers = new Map<SettingName, Array<Layered>>()

  const judge = (name: string, raw: string, source: Source): void => {
    const where = describeSource(source)
    const fact = known.get(name)
    if (fact === undefined) {
      const suggestion = closestSettingName(name)
      const closest =
        suggestion !== undefined && known.has(suggestion) && suggestion !== name
          ? suggestion
          : undefined
      const text = unknownText(name, closest)
      problems.push({
        severity:
          source.layer === "flag"
            ? "error"
            : source.layer !== "environment" || closest !== undefined
              ? "warning"
              : "note",
        kind: "unknown",
        message:
          source.layer === "flag" || source.layer === "environment"
            ? `${where}: ${text}`
            : `${where}: ${text}; ignored`,
        name,
        ...(closest === undefined ? {} : { closest }),
        source
      })
      return
    }
    if (source.layer === "flag" && (fact.scope === "secret" || fact.scope === "internal")) {
      problems.push({
        severity: "error",
        kind: "misplaced",
        message: `${where}: ${name} ${refusedFromFlag[fact.scope]}`,
        name,
        source
      })
      return
    }
    const inFile = source.layer === "project" || source.layer === "global"
    if (inFile && (fact.scope === "run" || fact.scope === "secret" || fact.scope === "internal")) {
      problems.push({
        severity: "warning",
        kind: "misplaced",
        message: `${where}: ${name} ${misplacedInFile[fact.scope](name)}`,
        name,
        source
      })
      return
    }
    const value =
      inFile && fact.path && raw.trim().length > 0
        ? expandPath(raw, source.layer === "project" ? input.repo : input.home, input.home)
        : raw
    const read = readSetting(fact.name, value)
    if (Result.isFailure(read)) {
      problems.push({
        severity: source.layer === "environment" ? "warning" : "error",
        kind: "unreadable",
        message: `${where}: ${name} must be ${read.failure}`,
        name,
        source
      })
      if (source.layer !== "environment") {
        return
      }
    } else if (read.success === undefined) {
      return
    }
    layers.set(fact.name, [...(layers.get(fact.name) ?? []), { source, raw: value }])
  }

  const flagsByName = new Map<string, ReadonlyArray<FlagAssignment>>()
  for (const flag of input.flags) {
    flagsByName.set(flag.name, [...(flagsByName.get(flag.name) ?? []), flag])
  }
  for (const [name, assignments] of flagsByName) {
    const [only, ...others] = assignments
    if (only === undefined) {
      continue
    }
    if (others.length > 0) {
      const flags = [...new Set(assignments.map((assignment) => assignment.flag))]
      problems.push({
        severity: "error",
        kind: "conflict",
        message:
          flags.length === 1
            ? `${only.flag}: ${name} is set more than once`
            : `${name} is set by ${flags.join(" and ")}; use one`,
        name
      })
      continue
    }
    judge(name, only.value, { layer: "flag", flag: only.flag })
  }

  for (const fact of input.facts) {
    const raw = input.environment[fact.name]
    if (raw !== undefined) {
      judge(fact.name, raw, { layer: "environment" })
    }
  }
  for (const name of Object.keys(input.environment).sort()) {
    if (name.startsWith("LLM4TS_") && !known.has(name) && input.environment[name] !== undefined) {
      judge(name, "", { layer: "environment" })
    }
  }

  const judgeFile = (layer: FileLayer, file: ConfigFile | undefined): void => {
    if (file === undefined) {
      return
    }
    problems.push(...file.problems)
    const last = new Map<string, number>()
    for (const line of file.lines) {
      if (line._tag === "Entry") {
        last.set(line.name, line.line)
      }
    }
    for (const line of file.lines) {
      if (line._tag !== "Entry") {
        continue
      }
      const source: Source = { layer, path: file.path, line: line.line }
      const winner = last.get(line.name)
      if (winner !== line.line) {
        problems.push({
          severity: "warning",
          kind: "duplicate",
          message: `${describeSource(source)}: ${line.name} is set again on line ${winner}; the last line wins`,
          name: line.name,
          source
        })
        continue
      }
      judge(line.name, line.value, source)
    }
  }
  judgeFile("project", input.project)
  judgeFile("global", input.global)

  const settings = new Map<SettingName, ResolvedSetting>()
  for (const fact of input.facts) {
    const [winner, ...shadowed] = layers.get(fact.name) ?? []
    if (winner === undefined) {
      continue
    }
    settings.set(fact.name, {
      name: fact.name,
      ...winner,
      shadowed,
      secret: fact.scope === "secret"
    })
    const below = shadowed[0]
    if (
      winner.source.layer === "environment" &&
      below !== undefined &&
      !sameValue(fact.name, winner.raw, below.raw)
    ) {
      problems.push({
        severity: "note",
        kind: "shadowed",
        message: `${fact.name} from the environment overrides ${describeSource(below.source)}`,
        name: fact.name,
        source: below.source
      })
    }
  }
  return { facts: input.facts, settings, problems }
}

/** The only environment a flow child may get; only `flowEnvironment` makes one. */
export type FlowEnvironment = Environment & Brand.Brand<"@llm4ts/shell/FlowEnvironment">

const brandFlowEnvironment = Brand.nominal<FlowEnvironment>()

// Today's readers disagree on toggle spellings; every one reads this pair.
const projected = (setting: ResolvedSetting): string => {
  const read = readSetting(setting.name, setting.raw)
  return Result.isSuccess(read) && typeof read.success === "boolean"
    ? read.success
      ? "1"
      : "off"
    : setting.raw
}

/**
 * What an in-process verb reads: `base`, plus each value a file or a flag
 * supplies (never a default). A value that comes from the environment is
 * left exactly as `base` holds it.
 */
export const resolvedEnvironment = (resolution: Resolution, base: Environment): Environment => ({
  ...base,
  ...Object.fromEntries(
    [...resolution.settings.values()]
      .filter((setting) => setting.source.layer !== "environment")
      .map((setting): readonly [string, string] => [setting.name, projected(setting)])
  )
})

/** The child's environment: the resolved one, minus `shellOnly` settings, plus `extra`. */
export const flowEnvironment = (
  resolution: Resolution,
  base: Environment,
  extra: Environment = {}
): FlowEnvironment => {
  const shellOnly = new Set<string>(
    resolution.facts.filter((fact) => fact.shellOnly).map((fact) => fact.name)
  )
  return brandFlowEnvironment({
    ...Object.fromEntries(
      Object.entries(resolvedEnvironment(resolution, base)).filter(([name]) => !shellOnly.has(name))
    ),
    ...extra
  })
}

/** The settings `flow` cannot start without that no layer sets. */
export const missingRequired = (
  resolution: Resolution,
  flow: string
): ReadonlyArray<SettingFacts> =>
  resolution.facts.filter(
    (fact) => fact.requiredBy.includes(flow) && !resolution.settings.has(fact.name)
  )

/**
 * How a value is written in a file: unquoted, double-quoted when it holds
 * whitespace or `#`, single-quoted when it holds `"`. The grammar has no
 * escapes, so a value with both quote kinds or a line break has no spelling.
 */
const writtenValue = (value: string): Result.Result<string, string> => {
  if (/[\n\r]/u.test(value)) {
    return Result.fail("a value cannot span lines")
  }
  if (value.includes('"')) {
    return value.includes("'")
      ? Result.fail(`a value cannot hold both ' and "`)
      : Result.succeed(`'${value}'`)
  }
  return Result.succeed(/[\s#]/u.test(value) || value.startsWith("'") ? `"${value}"` : value)
}

export interface ConfigChange {
  readonly name: string
  /** `undefined` removes the name. */
  readonly value: string | undefined
}

/**
 * Pure: `text` after setting or removing names. A set rewrites the name's
 * last line in place, keeping its `export` and its comment, or appends a
 * line; a removal drops every line of the name. Every other line stays byte
 * for byte, and setting the current value returns `text` itself. The
 * failure names the setting and the reason, never the value.
 */
export const editConfigText = (
  text: string,
  changes: ReadonlyArray<ConfigChange>
): Result.Result<string, string> => {
  let lines: ReadonlyArray<string> = text.split("\n")
  let changed = false
  for (const change of changes) {
    const holds = (raw: string): boolean => {
      const parsed = parseLine(raw)
      return parsed._tag === "Entry" && parsed.name === change.name
    }
    if (change.value === undefined) {
      const kept = lines.filter((raw) => !holds(raw))
      changed ||= kept.length !== lines.length
      lines = kept
      continue
    }
    const written = writtenValue(change.value)
    if (Result.isFailure(written)) {
      return Result.fail(`${change.name}: ${written.failure}`)
    }
    const at = lines.reduce((found, raw, index) => (holds(raw) ? index : found), -1)
    const current = lines[at]
    const parsed = current === undefined ? undefined : parseLine(current)
    if (current === undefined || parsed?._tag !== "Entry") {
      const entry = `${change.name}=${written.success}`
      lines = lines.at(-1) === "" ? [...lines.slice(0, -1), entry, ""] : [...lines, entry, ""]
      changed = true
      continue
    }
    if (parsed.value === change.value) {
      continue
    }
    const indent = current.slice(0, current.length - current.trimStart().length)
    const ending = current.endsWith("\r") ? "\r" : ""
    const rewritten = `${indent}${parsed.exported}${change.name}=${written.success}${parsed.comment}${ending}`
    lines = lines.map((raw, index) => (index === at ? rewritten : raw))
    changed = true
  }
  return Result.succeed(changed ? lines.join("\n") : text)
}

export interface PlannedSet {
  readonly name: SettingName
  readonly value: string
  /** The file `config set` writes it to. */
  readonly target: FileLayer
}

const refusedBySet = {
  run: (name: string) => `${name} is set per run: use llm4ts run --set ${name}=<value>`,
  secret: (name: string) =>
    `${name} is a secret: export it in the environment; it is never written to a file`,
  internal: (name: string) => `${name} is set by llm4ts`
}

/**
 * Pure: `config set` pairs checked against the registry and routed to a
 * file: a global setting to the global file, a project setting to the
 * project file, unless `target` forces one. Every refusal is reported, not
 * only the first.
 */
export const planSet = (
  facts: ReadonlyArray<SettingFacts>,
  assignments: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  target?: FileLayer
): Result.Result<ReadonlyArray<PlannedSet>, ReadonlyArray<string>> => {
  const known = new Map<string, SettingFacts>(facts.map((fact) => [fact.name, fact]))
  const planned: Array<PlannedSet> = []
  const refusals: Array<string> = []
  for (const { name, value } of assignments) {
    const fact = known.get(name)
    if (fact === undefined) {
      const suggestion = closestSettingName(name)
      refusals.push(
        unknownText(
          name,
          suggestion !== undefined && known.has(suggestion) ? suggestion : undefined
        )
      )
      continue
    }
    if (fact.scope === "run" || fact.scope === "secret" || fact.scope === "internal") {
      refusals.push(refusedBySet[fact.scope](name))
      continue
    }
    const read = readSetting(fact.name, value)
    if (Result.isFailure(read)) {
      refusals.push(`${name} must be ${read.failure}`)
      continue
    }
    if (read.success === undefined) {
      refusals.push(`${name} needs a value; llm4ts config unset ${name} removes it`)
      continue
    }
    const written = writtenValue(value)
    if (Result.isFailure(written)) {
      refusals.push(`${name}: ${written.failure}`)
      continue
    }
    planned.push({ name: fact.name, value, target: target ?? fact.scope })
  }
  return refusals.length > 0 ? Result.fail(refusals) : Result.succeed(planned)
}

const readFile = (files: PlainFileStoreShape, path: string) =>
  files
    .read(path)
    .pipe(
      Effect.mapError((error) =>
        ConfigFileError.make({ path, message: `cannot read ${path}: ${error.message}` })
      )
    )

export interface LoadedConfig {
  readonly resolution: Resolution
  /** `undefined`: the file is absent, or git tracks it and it is ignored. */
  readonly project: ConfigFile | undefined
  readonly global: ConfigFile | undefined
  /**
   * Git tracks the project file, so it came with the clone and none of it is
   * read: it could set commands llm4ts runs for whoever cloned the repository.
   */
  readonly projectTracked: boolean
}

const projectFileInRepo = join(".llm4ts", "config.env")

const runStateDirInRepo = ".llm4ts"

/**
 * Whether the repository supplies `<repo>/.llm4ts/config.env`: git tracks the
 * file, or tracks `.llm4ts` itself (a symbolic link or a submodule), in which
 * case the file behind it is the repository's too even though git reports
 * that path as unknown. No repository or no git: nothing was supplied.
 */
const trackedByGit = (executor: ProcessExecutorShape, repo: string): Effect.Effect<boolean> =>
  executor
    .run(["git", "ls-files", "-s", "--", runStateDirInRepo, projectFileInRepo], repo, {})
    .pipe(
      Effect.map(
        (result) =>
          result.exitCode === 0 &&
          result.stdout.some((line) => {
            const path = line.slice(line.indexOf("\t") + 1)
            return path === runStateDirInRepo || path === projectFileInRepo
          })
      ),
      Effect.orElseSucceed(() => false)
    )

/** Reads both files for `repo`, parses and resolves. An absent file is no problem. */
export const loadConfig = Effect.fn("@llm4ts/shell/Config.loadConfig")(function* (options: {
  readonly repo: string
  readonly environment: Environment
  readonly flags: ReadonlyArray<FlagAssignment>
  readonly files: PlainFileStoreShape
  readonly executor: ProcessExecutorShape
}): Effect.fn.Return<LoadedConfig, ConfigFileError> {
  const parsed = (path: string) =>
    readFile(options.files, path).pipe(
      Effect.map((text) => (text === undefined ? undefined : parseConfigFile(text, path)))
    )
  const global = yield* parsed(globalConfigPath(options.environment))
  const projectPath = projectConfigPath(options.repo)
  const found = yield* parsed(projectPath)
  const projectTracked =
    found !== undefined && (yield* trackedByGit(options.executor, options.repo))
  const project = projectTracked ? undefined : found
  const resolution = resolveConfig({
    facts: registryFacts,
    flags: options.flags,
    environment: options.environment,
    project,
    global,
    repo: options.repo,
    home: homeOf(options.environment)
  })
  return {
    resolution: projectTracked
      ? {
          ...resolution,
          problems: [
            ...resolution.problems,
            {
              severity: "warning",
              kind: "tracked",
              message: `${projectPath}: tracked by git, so it is ignored; llm4ts reads only a local project file. Untrack it: git rm --cached ${projectFileInRepo}`
            }
          ]
        }
      : resolution,
    project,
    global,
    projectTracked
  }
})

/** `convert-page` for `/flows/convert-page.ts`: the name `requiredBy` and `LLM4TS_FLOW` carry. */
export const flowNameOf = (flowPath: string): string => basename(flowPath, extname(flowPath))

/**
 * Pure: what a launch refuses over (every error) and what it prints first:
 * each warning, and each environment value that overrides a file. An unknown
 * environment name with no close setting stays silent: a user's own flow may
 * read it.
 */
export const launchProblems = (
  resolution: Resolution
): { readonly blocking: ReadonlyArray<string>; readonly notices: ReadonlyArray<string> } => ({
  blocking: resolution.problems
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.message),
  notices: resolution.problems.flatMap((problem) =>
    problem.severity === "warning"
      ? [`warning: ${problem.message}`]
      : problem.kind === "shadowed"
        ? [`note: ${problem.message}`]
        : []
  )
})

/** Pure: what `flow` lacks, with each setting's doc and the two ways to set it. */
export const renderMissing = (
  flow: string,
  repo: string,
  missing: ReadonlyArray<SettingFacts>
): string =>
  missing
    .flatMap((fact) => [
      `${flow} needs ${fact.name}: ${fact.doc}`,
      `  for this repository:  llm4ts config set --repo ${repo} ${fact.name}=<value>`,
      `  for this run only:    llm4ts run ${flow} --set ${fact.name}=<value>`
    ])
    .join("\n")

export interface LaunchPlan {
  readonly resolution: Resolution
  /** Printed to stderr before the child starts. */
  readonly notices: ReadonlyArray<string>
  readonly environment: FlowEnvironment
}

/**
 * The one way to a flow child's environment: loads the config for `repo`,
 * refuses on any error or on a setting `flow` cannot start without, and
 * projects the rest, naming the flow in `LLM4TS_FLOW`.
 */
export const prepareLaunch = Effect.fn("@llm4ts/shell/Config.prepareLaunch")(function* (options: {
  readonly repo: string
  readonly flow: string
  readonly base: Environment
  readonly flags: ReadonlyArray<FlagAssignment>
  readonly files: PlainFileStoreShape
  readonly executor: ProcessExecutorShape
  readonly extra?: Environment
}): Effect.fn.Return<LaunchPlan, ShellUsageError> {
  const { resolution } = yield* loadConfig({
    repo: options.repo,
    environment: options.base,
    flags: options.flags,
    files: options.files,
    executor: options.executor
  }).pipe(Effect.mapError((error) => new ShellUsageError({ message: error.message })))
  const { blocking, notices } = launchProblems(resolution)
  if (blocking.length > 0) {
    return yield* new ShellUsageError({ message: blocking.join("\n") })
  }
  const missing = missingRequired(resolution, options.flow)
  if (missing.length > 0) {
    return yield* new ShellUsageError({
      message: renderMissing(options.flow, options.repo, missing)
    })
  }
  return {
    resolution,
    notices,
    environment: flowEnvironment(resolution, options.base, {
      ...options.extra,
      LLM4TS_FLOW: options.flow
    })
  }
})

/**
 * Applies `changes` to the file at `path` and replaces it atomically; the
 * first write under a `.llm4ts/` directory leaves its `.gitignore`, as a
 * run's first write does. Succeeds with whether the file changed: setting
 * the current values writes nothing.
 */
export const writeConfig = Effect.fn("@llm4ts/shell/Config.writeConfig")(function* (options: {
  readonly files: PlainFileStoreShape
  readonly path: string
  readonly changes: ReadonlyArray<ConfigChange>
}): Effect.fn.Return<boolean, ConfigFileError> {
  const { path } = options
  const files = ignoringRunState(options.files)
  const before = (yield* readFile(files, path)) ?? ""
  const edited = editConfigText(before, options.changes)
  if (Result.isFailure(edited)) {
    return yield* ConfigFileError.make({ path, message: edited.failure })
  }
  if (edited.success === before) {
    return false
  }
  yield* files
    .writeAtomic(path, edited.success)
    .pipe(
      Effect.mapError((error) =>
        ConfigFileError.make({ path, message: `cannot write ${path}: ${error.message}` })
      )
    )
  return true
})
