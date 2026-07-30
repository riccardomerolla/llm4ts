import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { FileSystem } from "effect/FileSystem"
import * as Prompt from "effect/unstable/cli/Prompt"
import { coderChoices, findOnPath, resolvedCoderToken } from "./CoderChoice.ts"
import { discoverFlows, type DiscoveredFlow, type FlowTierPaths } from "./FlowCatalog.ts"
import { launchFlow } from "./FlowLaunch.ts"

type MenuAction = "run" | "view" | "exit"

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
    Prompt.select({
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
      title: `environment default (${resolved})`,
      value: undefined,
      description: "Use LLM4TS_CODER as-is"
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
  return yield* Prompt.run(Prompt.select({ message: "Which coding agent?", choices }))
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
    Prompt.text({ message: "Task text (empty uses the flow's default)" })
  )
  const coder = yield* selectCoder(process.env)
  const exitCode = yield* launchFlow({
    flowPath: flow.path,
    taskArgs: task.trim().length === 0 ? [] : [task],
    ...(coder === undefined ? {} : { coder })
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
 * The interactive main menu: run a flow, view a flow, exit. Ctrl-C inside a
 * prompt quits the menu cleanly rather than crashing the shell.
 */
export const mainMenu = Effect.fn("@llm4ts/shell/Menu.mainMenu")(function* (tiers: FlowTierPaths) {
  while (true) {
    const action = yield* Prompt.run(
      Prompt.select<MenuAction>({
        message: "llm4ts shell",
        choices: [
          { title: "Run a flow", value: "run" },
          { title: "View a flow", value: "view" },
          { title: "Exit", value: "exit" }
        ]
      })
    ).pipe(Effect.catchTag("QuitError", () => Effect.succeed<MenuAction>("exit")))
    switch (action) {
      case "run": {
        yield* runFlowInteractive(tiers).pipe(Effect.catchTag("QuitError", () => Effect.void))
        break
      }
      case "view": {
        yield* viewFlowInteractive(tiers).pipe(Effect.catchTag("QuitError", () => Effect.void))
        break
      }
      case "exit": {
        return
      }
    }
  }
})
