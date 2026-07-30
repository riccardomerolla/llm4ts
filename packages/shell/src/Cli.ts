import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { FileSystem } from "effect/FileSystem"
import * as Schema from "effect/Schema"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { makeCliProgram } from "@llm4ts/runner/Cli"
import { makeDoctorProgram } from "@llm4ts/runner/Doctor"
import {
  defaultTierPaths,
  discoverFlows,
  type DiscoveredFlow,
  type FlowTierPaths
} from "./FlowCatalog.ts"
import { launchFlow } from "./FlowLaunch.ts"
import { mainMenu } from "./Menu.ts"
import { packageVersion } from "./Package.ts"

export class ShellUsageError extends Schema.TaggedErrorClass<ShellUsageError>()("ShellUsage", {
  message: Schema.String
}) {}

export class ShellActionError extends Schema.TaggedErrorClass<ShellActionError>()("ShellAction", {
  message: Schema.String
}) {}

export const builtinFlowsDir = (): string => fileURLToPath(new URL("../flows", import.meta.url))

export const shellTierPaths = (options?: {
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}): FlowTierPaths =>
  defaultTierPaths({
    cwd: options?.cwd ?? process.cwd(),
    homeDir: homedir(),
    environment: options?.environment ?? process.env,
    builtinDir: builtinFlowsDir()
  })

const tierLabel = (flow: DiscoveredFlow): string => {
  const shadows = flow.shadows.length === 0 ? "" : ` shadows ${flow.shadows.join(", ")}`
  return `[${flow.tier}${shadows}]`
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
 * value containing a separator or ending in `.ts`) is used as-is, anything
 * else is looked up by name in the discovery listing.
 */
export const resolveFlow = Effect.fn("@llm4ts/shell/Cli.resolveFlow")(function* (
  reference: string,
  tiers: FlowTierPaths
) {
  if (reference.includes("/") || reference.endsWith(".ts")) {
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
    flow: Argument.string("flow").pipe(
      Argument.withDescription("Flow name from `llm4ts list`, or a path to a flow script")
    ),
    task: Argument.string("task").pipe(
      Argument.variadic(),
      Argument.withDescription("Task text passed to the flow")
    ),
    verbose: Flag.boolean("verbose").pipe(Flag.withDescription("Stream verbose flow output"))
  },
  (config) =>
    Effect.gen(function* () {
      const tiers = shellTierPaths()
      const flowPath = yield* resolveFlow(config.flow, tiers)
      const environment: Record<string, string | undefined> = { ...process.env }
      if (config.verbose) {
        environment.LLM4TS_VERBOSITY = "verbose"
      }
      const exitCode = yield* launchFlow({
        flowPath,
        taskArgs: config.task,
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
    json: Flag.boolean("json").pipe(Flag.withDescription("Emit the listing as JSON"))
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

const viewCommand = Command.make(
  "view",
  {
    flow: Argument.string("flow").pipe(
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
    prompt: Argument.string("prompt").pipe(
      Argument.variadic(),
      Argument.withDescription("Prompt streamed once to the selected coding agent")
    ),
    repo: Flag.string("repo").pipe(
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
  Command.withSubcommands([runCommand, listCommand, viewCommand, askCommand, doctorCommand])
)

export const runShellCommand = (
  argv: ReadonlyArray<string>
): Effect.Effect<void, unknown, Command.Environment> =>
  Command.runWith(shellCommand, { version: packageVersion })(argv)
