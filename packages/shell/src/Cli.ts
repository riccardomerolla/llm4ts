import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { FileSystem } from "effect/FileSystem"
import * as Schema from "effect/Schema"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { makeCliProgram } from "@llm4ts/runner/Cli"
import {
  CostsResult,
  makeCostsProgram,
  renderCostsResult,
  type CostsOptions
} from "@llm4ts/runner/Costs"
import { makeDoctorProgram } from "@llm4ts/runner/Doctor"
import {
  pauseExecutor,
  renderRosterReport,
  resumeExecutor,
  rosterReport
} from "@llm4ts/runner/ExecutorRoster"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { describeExclusion } from "@llm4ts/flow/Roster"
import { builtinKitsDir, discoverKits, kitTierPaths, type DiscoveredKit } from "@llm4ts/runner/Kits"
import {
  defaultTierPaths,
  discoverFlows,
  type DiscoveredFlow,
  type FlowTierPaths
} from "./FlowCatalog.ts"
import { launchFlow } from "./FlowLaunch.ts"
import { mainMenu } from "./Menu.ts"
import { ModDir, refineSession } from "./Refine.ts"
import { packageVersion } from "./Package.ts"

export class ShellUsageError extends Schema.TaggedError<ShellUsageError>()("ShellUsage", {
  message: Schema.String
}) {}

export class ShellActionError extends Schema.TaggedError<ShellActionError>()("ShellAction", {
  message: Schema.String
}) {}

export const builtinFlowsDir = (): string => fileURLToPath(new URL("../flows", import.meta.url))

export const shellTierPaths = (options?: {
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}): FlowTierPaths => {
  const cwd = options?.cwd ?? process.cwd()
  const environment = options?.environment ?? process.env
  const builtinKits = builtinKitsDir(builtinFlowsDir())
  return {
    ...defaultTierPaths({ cwd, homeDir: homedir(), environment, builtinDir: builtinFlowsDir() }),
    kits: kitTierPaths({
      cwd,
      homeDir: homedir(),
      environment,
      ...(builtinKits === undefined ? {} : { builtinDir: builtinKits })
    })
  }
}

const tierLabel = (flow: DiscoveredFlow): string => {
  const kit = flow.kit === undefined ? "" : ` kit:${flow.kit}`
  const shadows = flow.shadows.length === 0 ? "" : ` shadows ${flow.shadows.join(", ")}`
  return `[${flow.tier}${kit}${shadows}]`
}

export const renderKitList = (
  kits: ReadonlyArray<DiscoveredKit>,
  options?: { readonly json?: boolean }
): string => {
  if (options?.json === true) {
    return JSON.stringify(
      kits.map((kit) => ({
        name: kit.name,
        tier: kit.tier,
        path: kit.root,
        ...(kit.description === undefined ? {} : { description: kit.description }),
        packs: kit.packs,
        flows: kit.flows,
        shadows: kit.shadows
      })),
      undefined,
      2
    )
  }
  const nameWidth = kits.reduce((width, kit) => Math.max(width, kit.name.length), 0)
  return kits
    .flatMap((kit) => {
      const shadows = kit.shadows.length === 0 ? "" : ` shadows ${kit.shadows.join(", ")}`
      return [
        [
          kit.name.padEnd(nameWidth),
          `[${kit.tier}${shadows}]`,
          ...(kit.description === undefined ? [] : [kit.description])
        ].join("  "),
        ...(kit.packs.length === 0 ? [] : [`  packs: ${kit.packs.join(", ")}`]),
        ...(kit.flows.length === 0 ? [] : [`  flows: ${kit.flows.join(", ")}`])
      ]
    })
    .join("\n")
}

export const renderFlowList = (
  flows: ReadonlyArray<DiscoveredFlow>,
  options?: { readonly json?: boolean }
): string => {
  if (options?.json === true) {
    return JSON.stringify(
      flows.map((flow) => ({
        name: flow.name,
        tier: flow.tier,
        path: flow.path,
        ...(flow.kit === undefined ? {} : { kit: flow.kit }),
        ...(flow.description === undefined ? {} : { description: flow.description }),
        shadows: flow.shadows
      })),
      undefined,
      2
    )
  }
  const nameWidth = flows.reduce((width, flow) => Math.max(width, flow.name.length), 0)
  return flows
    .map((flow) =>
      [
        flow.name.padEnd(nameWidth),
        tierLabel(flow),
        ...(flow.description === undefined ? [] : [flow.description])
      ].join("  ")
    )
    .join("\n")
}

/**
 * Resolves a flow argument to a runnable script path: an explicit path (a
 * value containing a separator or ending in `.ts`/`.js`) is used as-is,
 * anything else is looked up by name in the discovery listing.
 */
export const resolveFlow = Effect.fn("@llm4ts/shell/Cli.resolveFlow")(function* (
  reference: string,
  tiers: FlowTierPaths
) {
  if (reference.includes("/") || reference.endsWith(".ts") || reference.endsWith(".js")) {
    const fs = yield* FileSystem
    const exists = yield* fs.exists(reference).pipe(Effect.orElseSucceed(() => false))
    if (!exists) {
      return yield* new ShellUsageError({ message: `flow script not found: ${reference}` })
    }
    return reference
  }
  const flows = yield* discoverFlows(tiers)
  const found = flows.find((flow) => flow.name === reference)
  if (found === undefined) {
    const known = flows.map((flow) => flow.name).join(", ")
    return yield* new ShellUsageError({
      message:
        known.length === 0
          ? `unknown flow '${reference}' (no flows discovered)`
          : `unknown flow '${reference}' (known flows: ${known})`
    })
  }
  return found.path
})

const runCommand = Command.make(
  "run",
  {
    flow: Argument.String("flow").pipe(
      Argument.withDescription("Flow name from `llm4ts list`, or a path to a flow script")
    ),
    task: Argument.String("task").pipe(
      Argument.variadic(),
      Argument.withDescription("Task text passed to the flow")
    ),
    repo: Flag.String("repo").pipe(
      Flag.optional,
      Flag.withDescription(
        "Repository to run against, forwarded to the flow as --repo (defaults to the current directory)"
      )
    ),
    pack: Flag.String("pack").pipe(
      Flag.optional,
      Flag.withDescription(
        "Pack for the modernization flows, forwarded as LLM4TS_PACK: a kit pack name from `llm4ts kits`, kit/pack, or a directory holding pack.md"
      )
    ),
    verbose: Flag.Boolean("verbose").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Stream verbose flow output")
    ),
    roster: Flag.String("roster").pipe(
      Flag.optional,
      Flag.withDescription(
        "Executor roster for this run, forwarded as LLM4TS_ROSTER: a roster file, or `none` for one executor per seat"
      )
    ),
    executors: Flag.String("executors").pipe(
      Flag.optional,
      Flag.withDescription(
        "Only these roster executors (comma-separated ids), forwarded as LLM4TS_EXECUTORS"
      )
    )
  },
  (config) =>
    Effect.gen(function* () {
      const tiers = shellTierPaths()
      const flowPath = yield* resolveFlow(config.flow, tiers)
      const environment: Record<string, string | undefined> = { ...process.env }
      if (config.verbose) {
        environment.LLM4TS_VERBOSITY = "verbose"
      }
      if (config.roster._tag === "Some") {
        environment.LLM4TS_ROSTER = config.roster.value
      }
      if (config.executors._tag === "Some") {
        environment.LLM4TS_EXECUTORS = config.executors.value
      }
      if (config.pack._tag === "Some") {
        environment.LLM4TS_PACK = config.pack.value
      }
      const exitCode = yield* launchFlow({
        flowPath,
        taskArgs: [
          ...(config.repo._tag === "Some" ? ["--repo", config.repo.value] : []),
          ...config.task
        ],
        environment
      })
      yield* Effect.sync(() => {
        process.exitCode = exitCode
      })
    })
).pipe(Command.withDescription("Run a discovered flow as a child process"))

const listCommand = Command.make(
  "list",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Emit the listing as JSON")
    )
  },
  (config) =>
    Effect.gen(function* () {
      const flows = yield* discoverFlows(shellTierPaths())
      if (flows.length === 0 && !config.json) {
        yield* Console.error("no flows discovered")
        return
      }
      yield* Console.log(renderFlowList(flows, { json: config.json }))
    })
).pipe(Command.withDescription("List flows across the project, global, and built-in tiers"))

const kitsCommand = Command.make(
  "kits",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Emit the listing as JSON")
    )
  },
  (config) =>
    Effect.gen(function* () {
      const tiers = shellTierPaths()
      const kits = tiers.kits === undefined ? [] : discoverKits(tiers.kits)
      if (kits.length === 0 && !config.json) {
        yield* Console.error("no kits discovered — add kit directories under .llm4ts/kits/")
        return
      }
      yield* Console.log(renderKitList(kits, { json: config.json }))
    })
).pipe(
  Command.withDescription(
    "List kits — packs, scaffolds, pattern cards, and flows — across the project, global, and built-in tiers"
  )
)

const viewCommand = Command.make(
  "view",
  {
    flow: Argument.String("flow").pipe(
      Argument.withDescription("Flow name from `llm4ts list`, or a path to a flow script")
    )
  },
  (config) =>
    Effect.gen(function* () {
      const flowPath = yield* resolveFlow(config.flow, shellTierPaths())
      const fs = yield* FileSystem
      const source = yield* fs
        .readFileString(flowPath)
        .pipe(Effect.mapError(() => new ShellActionError({ message: `cannot read ${flowPath}` })))
      yield* Console.log(source.trimEnd())
    })
).pipe(Command.withDescription("Print a flow's source"))

const askCommand = Command.make(
  "ask",
  {
    prompt: Argument.String("prompt").pipe(
      Argument.variadic(),
      Argument.withDescription("Prompt streamed once to the selected coding agent")
    ),
    repo: Flag.String("repo").pipe(
      Flag.optional,
      Flag.withDescription("Repository to run against (defaults to the current directory)")
    )
  },
  (config) =>
    Effect.gen(function* () {
      if (config.prompt.length === 0) {
        return yield* new ShellUsageError({ message: "ask needs a prompt" })
      }
      const argv = [
        config.prompt.join(" "),
        ...(config.repo._tag === "Some" ? ["--repo", config.repo.value] : [])
      ]
      yield* makeCliProgram(argv).pipe(
        Effect.mapError((error) =>
          error._tag === "ScriptUsage"
            ? new ShellUsageError({ message: error.message })
            : new ShellActionError({ message: error.message })
        )
      )
    })
).pipe(Command.withDescription("Stream a one-shot prompt to the selected coding agent"))

const refineCommand = Command.make(
  "refine",
  {
    repo: Flag.String("repo").pipe(
      Flag.optional,
      Flag.withDescription(
        "The LEGACY repository holding the extracted spec pack (defaults to the current directory)"
      )
    ),
    pack: Flag.String("pack").pipe(
      Flag.optional,
      Flag.withDescription("Pack forwarded as LLM4TS_PACK, as for `llm4ts run`")
    ),
    target: Flag.String("target").pipe(
      Flag.optional,
      Flag.withDescription(
        "The target repository, mounted read-only so the proposal can claim what it already provides (LLM4TS_TARGET_REPO)"
      )
    )
  },
  (config) =>
    Effect.gen(function* () {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return yield* new ShellUsageError({
          message:
            "refine is interactive; off a terminal edit docs/modernization/decisions.md and run `llm4ts run modernize-refine`"
        })
      }
      const repo = resolve(config.repo._tag === "Some" ? config.repo.value : process.cwd())
      const flowPath = yield* resolveFlow("modernize-refine", shellTierPaths())
      const environment: Record<string, string | undefined> = { ...process.env }
      if (config.pack._tag === "Some") {
        environment.LLM4TS_PACK = config.pack.value
      }
      if (config.target._tag === "Some") {
        environment.LLM4TS_TARGET_REPO = resolve(config.target.value)
      }
      yield* refineSession({
        modDir: join(repo, ModDir),
        environment,
        launch: (extra) =>
          launchFlow({
            flowPath,
            taskArgs: ["--repo", repo],
            environment: { ...environment, ...extra }
          }).pipe(Effect.catch((error) => Console.error(error.message).pipe(Effect.as(1))))
      })
    })
).pipe(
  Command.withDescription(
    "Interactively mark, deepen, and consolidate an extracted spec pack, then run modernize-refine on it (ADR 0015)"
  )
)

export interface CostsFlags {
  readonly repo: ReadonlyArray<string>
  readonly since: Option.Option<string>
  readonly tz: Option.Option<string>
  readonly runsPerDay: Option.Option<number>
}

/** Turns the `costs` flags into program options; every rejection is a usage error. */
export const costsOptionsFrom = (
  flags: CostsFlags,
  cwd: string = process.cwd()
): Effect.Effect<CostsOptions, ShellUsageError> =>
  Effect.gen(function* () {
    const repos = flags.repo.length === 0 ? [cwd] : flags.repo.map((repo) => resolve(cwd, repo))
    const since = Option.isNone(flags.since) ? undefined : Date.parse(flags.since.value)
    if (since !== undefined && Number.isNaN(since)) {
      return yield* new ShellUsageError({
        message: `--since needs an ISO date such as 2026-09-01 or 2026-09-01T00:00:00Z, got ${flags.since._tag === "Some" ? flags.since.value : ""}`
      })
    }
    const timeZone = Option.isNone(flags.tz)
      ? undefined
      : Option.getOrUndefined(DateTime.zoneMakeNamed(flags.tz.value))
    if (Option.isSome(flags.tz) && timeZone === undefined) {
      return yield* new ShellUsageError({
        message: `--tz needs an IANA zone such as Europe/Rome or UTC, got ${flags.tz.value}`
      })
    }
    const runsPerDay = Option.getOrUndefined(flags.runsPerDay)
    if (runsPerDay !== undefined && runsPerDay <= 0) {
      return yield* new ShellUsageError({ message: "--runs-per-day must be positive" })
    }
    return {
      repos,
      ...(since === undefined ? {} : { since }),
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(runsPerDay === undefined ? {} : { runsPerDay })
    }
  })

const costsCommand = Command.make(
  "costs",
  {
    repo: Flag.String("repo").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Repository whose .llm4ts/ traces to read; repeatable (defaults to the current directory)"
      )
    ),
    since: Flag.String("since").pipe(
      Flag.optional,
      Flag.withDescription("Only count token reports at or after this ISO date")
    ),
    tz: Flag.String("tz").pipe(
      Flag.optional,
      Flag.withDescription("IANA time zone for the day and hour buckets (default UTC)")
    ),
    runsPerDay: Flag.Int("runs-per-day").pipe(
      Flag.optional,
      Flag.withDescription("Assumed daily run count for a projected daily budget")
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Emit the report as JSON")
    )
  },
  (config) =>
    Effect.gen(function* () {
      const options = yield* costsOptionsFrom(config)
      const result = yield* makeCostsProgram(options)
      yield* Console.log(
        config.json
          ? Schema.encodeSync(Schema.fromJsonString(CostsResult))(result)
          : renderCostsResult(result)
      )
    })
).pipe(
  Command.withDescription(
    "Token and cost usage across past runs, bucketed per day and hour for budgeting"
  )
)

const rosterSource = (repo: Option.Option<string>) => ({
  files: nodePlainFileStore,
  environment: process.env,
  workDir: resolve(Option.getOrElse(repo, () => process.cwd()))
})

const rosterRepo = Flag.String("repo").pipe(
  Flag.optional,
  Flag.withDescription("Repository whose .llm4ts/roster.json overrides the user roster")
)

const rosterPauseCommand = Command.make(
  "pause",
  {
    id: Argument.String("executor").pipe(Argument.withDescription("Executor id")),
    for: Flag.String("for").pipe(
      Flag.optional,
      Flag.withDescription('How long ("2h", "30 minutes"); until resumed when omitted')
    ),
    repo: rosterRepo
  },
  (config) =>
    Effect.gen(function* () {
      const exclusion = yield* pauseExecutor(
        rosterSource(config.repo),
        config.id,
        Option.getOrUndefined(config.for)
      )
      yield* Console.log(`${config.id} out ${describeExclusion(exclusion)}`)
    })
).pipe(Command.withDescription("Take an executor out of every run's pick-up round"))

const rosterResumeCommand = Command.make(
  "resume",
  {
    id: Argument.String("executor").pipe(Argument.withDescription("Executor id")),
    repo: rosterRepo
  },
  (config) =>
    Effect.gen(function* () {
      yield* resumeExecutor(rosterSource(config.repo), config.id)
      yield* Console.log(`${config.id} back in the round`)
    })
).pipe(Command.withDescription("Put an executor back in the pick-up round"))

const rosterCommand = Command.make("roster", { repo: rosterRepo }, (config) =>
  Effect.gen(function* () {
    const report = yield* rosterReport(rosterSource(config.repo))
    yield* Console.log(renderRosterReport(report))
  })
).pipe(
  Command.withDescription(
    "The executor roster (ADR 0019): executors, their roles and slots, and who is out of the round"
  ),
  Command.withSubcommands([rosterPauseCommand, rosterResumeCommand])
)

const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const report = yield* makeDoctorProgram()
    yield* Console.log(report.trimEnd())
  })
).pipe(Command.withDescription("Report available connectors and credentials"))

export const shellCommand = Command.make("llm4ts", {}, () =>
  Effect.gen(function* () {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return yield* new ShellUsageError({
        message: "no command given and no interactive terminal; try `llm4ts --help`"
      })
    }
    yield* mainMenu(shellTierPaths())
  })
).pipe(
  Command.withDescription(
    "Interactive shell and CLI for llm4ts flows: discover, inspect, and run them."
  ),
  Command.withSubcommands([
    runCommand,
    listCommand,
    kitsCommand,
    viewCommand,
    askCommand,
    refineCommand,
    costsCommand,
    rosterCommand,
    doctorCommand
  ])
)

export const runShellCommand = (
  argv: ReadonlyArray<string>
): Effect.Effect<void, unknown, Command.Environment> =>
  Command.runWith(shellCommand, { version: packageVersion })(argv)
