import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { FileSystem } from "effect/FileSystem"
import { Prompt } from "effect/cli"
import { coderChoices, findOnPath, resolvedCoderToken } from "./CoderChoice.ts"
import { launchTrustRefusal, loadConfig, prepareLaunch, resolvedEnvironment } from "./Config.ts"
import { openConfigEditor } from "./ConfigCommand.ts"
import { discoverFlows, type DiscoveredFlow, type FlowTierPaths } from "./FlowCatalog.ts"
import { launchFlow } from "./FlowLaunch.ts"
import { ShellUsageError } from "./ShellErrors.ts"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"

const launchDeps = { files: nodePlainFileStore }

type MenuAction = "run" | "view" | "configure" | "exit"

const flowChoice = (flow: DiscoveredFlow): Prompt.SelectChoice<DiscoveredFlow> => {
  const shadows = flow.shadows.length === 0 ? "" : ` (shadows ${flow.shadows.join(", ")})`
  return {
    title: `${flow.name} [${flow.tier}]${shadows}`,
    value: flow,
    ...(flow.description === undefined ? {} : { description: flow.description })
  }
}

const selectFlow = Effect.fn("@llm4ts/shell/Menu.selectFlow")(function* (tiers: FlowTierPaths) {
  const flows = yield* discoverFlows(tiers)
  if (flows.length === 0) {
    yield* Console.error("no flows discovered — add scripts under .llm4ts/flows/")
    return undefined
  }
  return yield* Prompt.run(
    Prompt.Select({
      message: "Which flow?",
      choices: flows.map(flowChoice)
    })
  )
})

const selectCoder = Effect.fn("@llm4ts/shell/Menu.selectCoder")(function* (
  environment: Readonly<Record<string, string | undefined>>
) {
  const resolved = resolvedCoderToken(environment)
  const choices: Array<Prompt.SelectChoice<string | undefined>> = [
    {
      title: `configured (${resolved})`,
      value: undefined,
      description: "LLM4TS_CODER from the environment or the config files"
    },
    ...coderChoices.map(
      (choice): Prompt.SelectChoice<string | undefined> => ({
        title:
          findOnPath(choice.executable, environment) === undefined
            ? choice.token
            : `${choice.token} ✓ found`,
        value: choice.token
      })
    )
  ]
  return yield* Prompt.run(Prompt.Select({ message: "Which coding agent?", choices }))
})

const runFlowInteractive = Effect.fn("@llm4ts/shell/Menu.runFlowInteractive")(function* (
  tiers: FlowTierPaths
) {
  const flow = yield* selectFlow(tiers)
  if (flow === undefined) {
    return
  }
  if (flow.description !== undefined) {
    yield* Console.log(`${flow.name}: ${flow.description}`)
  }
  const task = yield* Prompt.run(
    Prompt.String({ message: "Task text (empty uses the flow's default)" })
  )
  const repo = process.cwd()
  const settled = yield* loadConfig({ repo, environment: process.env, flags: [], ...launchDeps })
  const refusal = launchTrustRefusal(settled, repo)
  if (refusal !== undefined) {
    return yield* new ShellUsageError({ message: refusal })
  }
  const coder = yield* selectCoder(resolvedEnvironment(settled.resolution, process.env))
  const plan = yield* prepareLaunch({
    repo,
    flow: flow.name,
    base: process.env,
    flags: coder === undefined ? [] : [{ name: "LLM4TS_CODER", value: coder, flag: "the menu" }],
    ...launchDeps
  })
  yield* Effect.forEach(plan.notices, (notice) => Console.error(notice), { discard: true })
  const exitCode = yield* launchFlow({
    flowPath: flow.path,
    taskArgs: task.trim().length === 0 ? [] : [task],
    environment: plan.environment
  })
  yield* exitCode === 0
    ? Console.log(`${flow.name} completed`)
    : Console.error(`${flow.name} exited with code ${exitCode}`)
})

const viewFlowInteractive = Effect.fn("@llm4ts/shell/Menu.viewFlowInteractive")(function* (
  tiers: FlowTierPaths
) {
  const flow = yield* selectFlow(tiers)
  if (flow === undefined) {
    return
  }
  const fs = yield* FileSystem
  const source = yield* fs.readFileString(flow.path).pipe(Effect.orElseSucceed(() => ""))
  yield* Console.log(source.trimEnd())
})

/**
 * The interactive main menu: run a flow, view a flow, configure settings, exit. Ctrl-C inside a
 * prompt quits the menu cleanly rather than crashing the shell.
 */
export const mainMenu = Effect.fn("@llm4ts/shell/Menu.mainMenu")(function* (tiers: FlowTierPaths) {
  while (true) {
    const action = yield* Prompt.run(
      Prompt.Select<MenuAction>({
        message: "llm4ts shell",
        choices: [
          { title: "Run a flow", value: "run" },
          { title: "View a flow", value: "view" },
          { title: "Configure settings", value: "configure" },
          { title: "Exit", value: "exit" }
        ]
      })
    ).pipe(Effect.catchTag("QuitError", () => Effect.succeed<MenuAction>("exit")))
    switch (action) {
      case "run": {
        yield* runFlowInteractive(tiers).pipe(
          Effect.catchTag("QuitError", () => Effect.void),
          Effect.catchTags({
            ShellUsage: (error) => Console.error(error.message),
            ConfigFileError: (error) => Console.error(error.message)
          })
        )
        break
      }
      case "view": {
        yield* viewFlowInteractive(tiers).pipe(Effect.catchTag("QuitError", () => Effect.void))
        break
      }
      case "configure": {
        yield* openConfigEditor(process.cwd()).pipe(
          Effect.catchTag("ShellUsage", (error) => Console.error(error.message))
        )
        break
      }
      case "exit": {
        return
      }
    }
  }
})
