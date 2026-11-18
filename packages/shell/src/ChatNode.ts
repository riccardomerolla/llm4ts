// @internal: the Node wiring of `llm4ts chat`, used only by the CLI
import { basename, resolve } from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import type { PersistenceError } from "@llm4ts/flow/FlowError"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { makeGitTool } from "@llm4ts/flow/GitTool"
import { makeGoogleChatTool, parseSpaceRef } from "@llm4ts/flow/GoogleChatTool"
import { settingValue } from "@llm4ts/flow/Settings"
import { asToolless, readOnlySeatProblem, reasonerFromEnvironment } from "@llm4ts/runner/Connectors"
import { interruptOnSignal, type SignalSource } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import {
  decideThroughFlow,
  runChat,
  type ChatLoopDeps,
  type ChatOptions,
  type ChatStopped
} from "./ChatLoop.ts"
import { nodeListTraces } from "./Costs.ts"
import { discoverFlows, type FlowTierPaths } from "./FlowCatalog.ts"
import { nodeFlowProcess } from "./FlowProcess.ts"
import { nodeListFiles } from "./OperatorNode.ts"
import { makeRunSupervisor } from "./RunSupervisor.ts"
import { ShellUsageError } from "./ShellErrors.ts"
import { nodeListEpics } from "./Watch.ts"

type Environment = Readonly<Record<string, string | undefined>>

export interface ChatFlags {
  readonly space: Option.Option<string>
  readonly trigger: Option.Option<string>
  readonly marker: Option.Option<string>
  readonly allow: ReadonlyArray<string>
  /** Comma-separated flow names. */
  readonly flows: Option.Option<string>
  readonly interval: Option.Option<number>
  readonly observe: boolean
}

export const defaultMarker = "🌙 chief:"
export const defaultIntervalSeconds = 5
export const defaultFlows: ReadonlyArray<string> = ["implement"]

const usage = (message: string): ShellUsageError => new ShellUsageError({ message })

/** The `chat` flags over the settings; a flag wins, and every rejection is a usage error. */
export const chatOptionsFrom = (
  flags: ChatFlags,
  environment: Environment
): Effect.Effect<ChatOptions, ShellUsageError> =>
  Effect.gen(function* () {
    const spaceText =
      Option.getOrUndefined(flags.space) ?? settingValue("LLM4TS_CHAT_SPACE", environment)
    if (spaceText === undefined || spaceText.trim() === "") {
      return yield* usage("chat needs a space: --space spaces/AAAA… or LLM4TS_CHAT_SPACE")
    }
    const space = parseSpaceRef(spaceText)
    if (space === undefined) {
      return yield* usage(`"${spaceText}" is not a Chat space; give spaces/AAAA… or its id`)
    }
    const trigger = Option.getOrElse(flags.trigger, () =>
      settingValue("LLM4TS_CHAT_TRIGGER", environment)
    ).trim()
    if (trigger === "") return yield* usage("--trigger must not be empty")
    const marker = Option.getOrElse(flags.marker, () => defaultMarker).trim()
    if (marker === "") return yield* usage("--marker must not be empty")
    const stranger = flags.allow.find((who) => !/^users\/\S+$/u.test(who))
    if (stranger !== undefined) {
      return yield* usage(`--allow takes a user id such as users/1234567890, not "${stranger}"`)
    }
    const flows = Option.match(flags.flows, {
      onNone: () => defaultFlows,
      onSome: (text) =>
        text
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
    })
    if (flows.length === 0) return yield* usage("--flows names no flow")
    const intervalSeconds = Option.getOrElse(flags.interval, () => defaultIntervalSeconds)
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
      return yield* usage("--interval must be a whole number of seconds, 1 or more")
    }
    return {
      space,
      trigger,
      marker,
      allow: flags.allow,
      flows: [...new Set(flows)],
      intervalSeconds,
      observe: flags.observe
    }
  })

// Tools outside a flow run publish to nobody.
const noEvents: FlowEventsShape = { publish: () => Effect.void }

/**
 * The chat loop's dependencies on Node for the repository at `cwd`, and
 * only that one: the supervisor knows no other, so a run id the Chief names
 * cannot reach elsewhere. Flows start with the process environment, as under
 * `llm4ts mcp`; the reasoning seat is checked against `settings`, the
 * environment with the config files applied. The supervisor lives in the
 * scope, so closing it stops every run started from chat.
 */
export const nodeChatDeps = (
  options: ChatOptions,
  cwd: string,
  tierPaths: FlowTierPaths,
  settings: Environment = process.env
): Effect.Effect<ChatLoopDeps, PersistenceError, Scope.Scope> =>
  Effect.gen(function* () {
    const path = resolve(cwd)
    const repo = { id: basename(path), path }
    const environment: Environment = process.env
    const supervisor = yield* makeRunSupervisor({
      repos: [repo],
      environment,
      files: nodePlainFileStore,
      process: nodeFlowProcess,
      parallelRuns: 1
    })
    const deps: Omit<ChatLoopDeps, "decide"> = {
      chat: makeGoogleChatTool(nodeProcessExecutor, path, noEvents),
      files: nodePlainFileStore,
      supervisor,
      git: makeGitTool(nodeProcessExecutor, path, noEvents),
      repo,
      flows: discoverFlows(tierPaths).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.map((flows) =>
          flows.map((flow) => ({
            name: flow.name,
            path: flow.path,
            description: flow.description ?? ""
          }))
        ),
        Effect.orElseSucceed(() => [])
      ),
      sources: { files: nodePlainFileStore, listFiles: nodeListFiles },
      listTraces: nodeListTraces,
      listEpics: nodeListEpics,
      environment,
      now: Clock.currentTimeMillis,
      say: (line) => Console.log(line),
      strangers: yield* Ref.make<ReadonlySet<string>>(new Set()),
      seatProblem: reasonerFromEnvironment(settings).pipe(
        Effect.map((seat) => readOnlySeatProblem(asToolless(seat))),
        Effect.catch((error) => Effect.succeed(error.message))
      ),
      ignored: nodeProcessExecutor.run(["git", "check-ignore", "-q", ".llm4ts/"], path, {}).pipe(
        Effect.map((result) => result.exitCode === 0),
        Effect.orElseSucceed(() => false)
      ),
      options
    }
    return { ...deps, decide: decideThroughFlow(deps) }
  })

/**
 * Runs the chat loop until it stops or a signal arrives. The first SIGINT or
 * SIGTERM interrupts it and ends cleanly; closing the scope then stops the
 * runs started from chat, as `llm4ts mcp` does. A second signal exits at
 * once (130 or 143).
 */
export const runChatUntilSignal = <E>(
  deps: Effect.Effect<ChatLoopDeps, E, Scope.Scope>,
  signals: SignalSource
): Effect.Effect<void, E | ChatStopped | PersistenceError> => {
  const disposers: Array<() => void> = []
  return Effect.scoped(
    Effect.gen(function* () {
      const built = yield* deps
      const fiber = yield* Effect.forkScoped(runChat(built))
      disposers.push(interruptOnSignal(fiber, signals, ["SIGINT", "SIGTERM"]))
      const exit = yield* Fiber.await(fiber)
      if (Exit.isSuccess(exit)) return
      if (Cause.hasInterruptsOnly(exit.cause)) {
        yield* built.say("Stopping; runs started from chat are stopped too.")
        return
      }
      return yield* Effect.failCause(exit.cause)
    })
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const dispose of disposers) dispose()
      })
    )
  )
}
