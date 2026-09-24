// Loading the executor roster (ADR 0019): the user's file, the repository's
// override, the per-run choice (`LLM4TS_ROSTER`, `LLM4TS_EXECUTORS`), and the
// mapping from an executor to the connector config the registry resolves.
// Harness knowledge lives here, beside the connector presets; the roster
// itself (`@llm4ts/flow/Roster`) knows only ids, roles and slots.
import { homedir } from "node:os"
import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ApiConnectorConfig,
  CliConnectorConfig,
  type ConnectorConfig
} from "@llm4ts/core/ConnectorConfig"
import { RosterInvalid, type FlowError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  Exclusion,
  RosterDocument,
  coderSlotsOf,
  describeExclusion,
  hasRole,
  makeRosterStateStore,
  mergeRosterDocuments,
  narrowRoster,
  parseDuration,
  rolesOf,
  rosterViolations,
  slotsOf,
  type ExecutorSpec
} from "@llm4ts/flow/Roster"
import { apiPresetFor, asReadOnly, coderFor, withEnvironment, withModel } from "./Connectors.ts"

type Environment = Readonly<Record<string, string | undefined>>

const home = (environment: Environment): string => environment.HOME ?? homedir()

/** `${XDG_CONFIG_HOME:-~/.config}/llm4ts/roster.json`. */
export const userRosterPath = (environment: Environment): string =>
  join(environment.XDG_CONFIG_HOME ?? join(home(environment), ".config"), "llm4ts", "roster.json")

/** `<repo>/.llm4ts/roster.json`: overrides the user's entries by id. */
export const repoRosterPath = (workDir: string): string => join(workDir, ".llm4ts", "roster.json")

/** `${XDG_STATE_HOME:-~/.local/state}/llm4ts/roster-state.json`: exclusions that outlive a run. */
export const rosterStatePath = (environment: Environment): string =>
  join(
    environment.XDG_STATE_HOME ?? join(home(environment), ".local", "state"),
    "llm4ts",
    "roster-state.json"
  )

const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** `${VAR}` references resolved from the environment; the names of missing ones. */
export const substituteEnvironment = (
  values: Readonly<Record<string, string>>,
  environment: Environment
): {
  readonly values: Readonly<Record<string, string>>
  readonly missing: ReadonlyArray<string>
} => {
  const missing: Array<string> = []
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = value.replace(reference, (_match, name: string) => {
      const found = environment[name]
      if (found === undefined) {
        missing.push(name)
        return ""
      }
      return found
    })
  }
  return { values: resolved, missing: [...new Set(missing)] }
}

/** Whether a harness name is an API provider (reasoning roles only). */
export const isApiHarness = (harness: string): boolean =>
  coderFor(harness) === undefined && apiPresetFor(harness) !== undefined

/**
 * The connector config an executor runs with: its harness preset, model,
 * flags, endpoint and environment, read-only for a reasoning role.
 */
export const executorConfig = (
  spec: ExecutorSpec,
  readOnly: boolean,
  environment: Environment
): ConnectorConfig | undefined => {
  const cli = coderFor(spec.harness)
  if (cli !== undefined) {
    const modelled = spec.model === undefined ? cli : withModel(cli, spec.model)
    const flagged =
      spec.flags === undefined
        ? modelled
        : CliConnectorConfig.make({ ...modelled, flags: { ...modelled.flags, ...spec.flags } })
    const withEnv =
      spec.env === undefined
        ? flagged
        : withEnvironment(flagged, substituteEnvironment(spec.env, environment).values)
    return readOnly ? asReadOnly(withEnv) : withEnv
  }
  const api = apiPresetFor(spec.harness)
  if (api === undefined) {
    return undefined
  }
  const modelled = spec.model === undefined ? api : withModel(api, spec.model)
  return spec.baseUrl === undefined
    ? modelled
    : ApiConnectorConfig.make({ ...modelled, baseUrl: spec.baseUrl })
}

/** The flow-level violations plus what needs the harness table and the environment. */
export const rosterLoadViolations = (
  document: RosterDocument,
  environment: Environment
): ReadonlyArray<string> => {
  const violations = [...rosterViolations(document)]
  for (const spec of document.executors) {
    const where = `executor '${spec.id}'`
    if (coderFor(spec.harness) === undefined && apiPresetFor(spec.harness) === undefined) {
      violations.push(`${where} has an unknown harness '${spec.harness}'`)
    } else if (isApiHarness(spec.harness) && hasRole(spec, "coder")) {
      violations.push(
        `${where} is an API provider ('${spec.harness}'): it may reason, but coding needs a CLI harness`
      )
    }
    const missing = substituteEnvironment(spec.env ?? {}, environment).missing
    if (missing.length > 0) {
      violations.push(`${where} references unset variable(s) ${missing.join(", ")}`)
    }
  }
  return violations
}

const parseRoster = (path: string, text: string): Effect.Effect<RosterDocument, RosterInvalid> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (error) =>
      RosterInvalid.make({
        path,
        violations: [`not JSON: ${error instanceof Error ? error.message : String(error)}`]
      })
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(RosterDocument)(json).pipe(
        Effect.mapError((error) => RosterInvalid.make({ path, violations: [error.message] }))
      )
    )
  )

const readRoster = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<RosterDocument | undefined, FlowError> =>
  Effect.flatMap(files.read(path), (text) =>
    text === undefined ? Effect.succeed(undefined) : parseRoster(path, text)
  )

export interface RosterSource {
  readonly files: PlainFileStoreShape
  readonly environment: Environment
  readonly workDir: string
}

/**
 * The roster in force for a run, or `undefined` for today's one executor per
 * seat: `LLM4TS_ROSTER=none` ignores rosters, `LLM4TS_ROSTER=<path>` uses that
 * file alone, otherwise the user's file with the repository's over it.
 * `LLM4TS_EXECUTORS=a,b` narrows the result to those ids.
 */
export const loadRosterDocument = Effect.fn("@llm4ts/runner/ExecutorRoster.load")(function* (
  source: RosterSource
): Effect.fn.Return<RosterDocument | undefined, FlowError> {
  const chosen = source.environment.LLM4TS_ROSTER?.trim()
  if (chosen === "none") {
    return undefined
  }
  const loaded = yield* chosen !== undefined && chosen.length > 0
    ? Effect.flatMap(readRoster(source.files, chosen), (document) =>
        document === undefined
          ? Effect.fail(RosterInvalid.make({ path: chosen, violations: ["no roster file there"] }))
          : Effect.succeed({ document, where: chosen })
      )
    : Effect.gen(function* () {
        const user = userRosterPath(source.environment)
        const repo = repoRosterPath(source.workDir)
        const userDocument = yield* readRoster(source.files, user)
        const repoDocument = yield* readRoster(source.files, repo)
        if (userDocument === undefined && repoDocument === undefined) {
          return undefined
        }
        const where = [
          userDocument === undefined ? undefined : user,
          repoDocument === undefined ? undefined : repo
        ]
          .filter((path): path is string => path !== undefined)
          .join(" + ")
        return { document: mergeRosterDocuments(userDocument, repoDocument), where }
      })
  if (loaded === undefined) {
    return undefined
  }
  const { document, where } = loaded
  const ids = (source.environment.LLM4TS_EXECUTORS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const unknown = ids.filter((id) => !document.executors.some((spec) => spec.id === id))
  const narrowed = narrowRoster(document, ids)
  const violations = [
    ...rosterLoadViolations(narrowed, source.environment),
    ...unknown.map((id) => `LLM4TS_EXECUTORS names '${id}', which the roster does not have`),
    ...(narrowed.executors.length === 0 ? ["no executor left to run with"] : [])
  ]
  if (violations.length > 0) {
    return yield* RosterInvalid.make({ path: where, violations })
  }
  return narrowed
})

/** Whether `url` answers 2xx within five seconds: a roster executor's health check. */
export const httpProbe = (url: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => fetch(url, { signal: AbortSignal.timeout(5_000) })).pipe(
    Effect.map((response) => response.ok),
    Effect.catch(() => Effect.succeed(false))
  )

// ---- `llm4ts roster` -------------------------------------------------------------

export interface RosterReport {
  readonly document: RosterDocument | undefined
  readonly exclusions: ReadonlyArray<Exclusion>
  readonly statePath: string
}

/** The roster in force here and the exclusions persisted for it. */
export const rosterReport = Effect.fn("@llm4ts/runner/ExecutorRoster.report")(function* (
  source: RosterSource
): Effect.fn.Return<RosterReport, FlowError> {
  const document = yield* loadRosterDocument(source)
  const statePath = rosterStatePath(source.environment)
  const exclusions = yield* makeRosterStateStore(source.files, statePath).load
  return { document, exclusions, statePath }
})

const priorityText = (spec: ExecutorSpec): string => {
  const priority = spec.priority
  if (priority === undefined) {
    return "priority 1"
  }
  if (typeof priority === "number") {
    return `priority ${priority}`
  }
  return `priority ${Object.entries(priority)
    .map(([role, value]) => `${role} ${value}`)
    .join(", ")}`
}

export const renderRosterReport = (report: RosterReport): string => {
  if (report.document === undefined) {
    return [
      "no roster: every run uses one executor per seat (LLM4TS_CODER and the flow's defaults).",
      "Write ~/.config/llm4ts/roster.json (or <repo>/.llm4ts/roster.json) to pool executors."
    ].join("\n")
  }
  const lines = [`executors (${report.document.executors.length}):`]
  for (const spec of report.document.executors) {
    const exclusion = report.exclusions.find((candidate) => candidate.id === spec.id)
    const slots = slotsOf(spec)
    const coders = hasRole(spec, "coder") ? `, ${coderSlotsOf(spec)} for coding` : ""
    lines.push(
      `- ${spec.id}: ${spec.harness}${spec.model === undefined ? "" : ` ${spec.model}`} · ${rolesOf(spec).join(", ")} · ${slots} slot(s)${coders} · ${priorityText(spec)}`,
      `  ${exclusion === undefined ? "in the round" : `out ${describeExclusion(exclusion)}`}`
    )
  }
  lines.push(`state: ${report.statePath}`)
  return lines.join("\n")
}

/** Takes an executor out of every run's pick-up round, for a while or until resumed. */
export const pauseExecutor = Effect.fn("@llm4ts/runner/ExecutorRoster.pause")(function* (
  source: RosterSource,
  id: string,
  duration: string | undefined
): Effect.fn.Return<Exclusion, FlowError> {
  const document = yield* loadRosterDocument(source)
  if (document === undefined || !document.executors.some((spec) => spec.id === id)) {
    return yield* RosterInvalid.make({ violations: [`no executor '${id}' in the roster`] })
  }
  const span = duration === undefined ? undefined : parseDuration(duration)
  if (duration !== undefined && span === undefined) {
    return yield* RosterInvalid.make({ violations: [`cannot read the duration '${duration}'`] })
  }
  const now = yield* Clock.currentTimeMillis
  const exclusion = Exclusion.make({
    id,
    kind: "manual",
    reason: "paused by the operator",
    ...(span === undefined ? {} : { until: now + Duration.toMillis(span) })
  })
  yield* makeRosterStateStore(source.files, rosterStatePath(source.environment)).save(
    [id],
    [exclusion]
  )
  return exclusion
})

/** Puts an executor back in the round, whatever took it out. */
export const resumeExecutor = Effect.fn("@llm4ts/runner/ExecutorRoster.resume")(function* (
  source: RosterSource,
  id: string
): Effect.fn.Return<void, FlowError> {
  yield* makeRosterStateStore(source.files, rosterStatePath(source.environment)).save([id], [])
})
