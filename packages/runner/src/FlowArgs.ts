import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export interface FlowArgs {
  readonly promptText?: string
  readonly promptFile?: string
  readonly repo?: string
  readonly help?: boolean
  readonly version?: boolean
}

export const FlowUsage =
  'usage: llm4ts ["<prompt>" | --prompt-file <path> | @<path>] [--repo <path>] | llm4ts doctor'

export const FlowHelp = `${FlowUsage}

Stream one prompt to your configured coding agent and print the response.

arguments:
  "<prompt>"              prompt text
  @<path>                 read the prompt from a file
  --prompt-file <path>    read the prompt from a file
  --repo, -C <path>       run against this repository (default: current directory)
  -h, --help              show this help
  --version               print the version

commands:
  doctor                  check connector availability and credentials

environment:
  LLM4TS_CODER            coding agent: claude|codex|gemini|pi|agy|grok|cursor|opencode (default: claude)
  LLM4TS_VERBOSITY        terminal verbosity: quiet|normal|verbose
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
                          credentials for API providers

A trace of each run is written under .llm4ts/ in the target repository.
`

export class ScriptUsage extends Schema.TaggedErrorClass<ScriptUsage>()("ScriptUsage", {
  message: Schema.String
}) {}

export type FlowArgsParseResult =
  | { readonly ok: true; readonly value: FlowArgs }
  | { readonly ok: false; readonly error: ScriptUsage }

export const parseFlowArgs = (args: ReadonlyArray<string>): FlowArgsParseResult => {
  let parsed: FlowArgs = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ""
    if (argument === "--") {
      continue
    } else if (argument === "--help" || argument === "-h") {
      parsed = { ...parsed, help: true }
    } else if (argument === "--version") {
      parsed = { ...parsed, version: true }
    } else if (argument === "--prompt-file") {
      const value = args[index + 1]
      if (value === undefined) {
        return {
          ok: false,
          error: ScriptUsage.make({
            message: `--prompt-file requires a path\n${FlowUsage}`
          })
        }
      }
      parsed = { ...parsed, promptFile: value }
      index += 1
    } else if (argument.startsWith("--prompt-file=")) {
      parsed = {
        ...parsed,
        promptFile: argument.slice("--prompt-file=".length)
      }
    } else if (argument === "--repo" || argument === "-C") {
      const value = args[index + 1]
      if (value === undefined) {
        return {
          ok: false,
          error: ScriptUsage.make({
            message: `${argument} requires a path\n${FlowUsage}`
          })
        }
      }
      parsed = { ...parsed, repo: value }
      index += 1
    } else if (argument.startsWith("--repo=")) {
      parsed = { ...parsed, repo: argument.slice("--repo=".length) }
    } else if (argument.startsWith("--")) {
      return {
        ok: false,
        error: ScriptUsage.make({
          message: `unknown flag: ${argument}\n${FlowUsage}`
        })
      }
    } else if (argument.startsWith("@") && argument.length > 1 && parsed.promptFile === undefined) {
      parsed = { ...parsed, promptFile: argument.slice(1) }
    } else if (parsed.promptText === undefined && argument.trim().length > 0) {
      parsed = { ...parsed, promptText: argument.trim() }
    }
  }
  return { ok: true, value: parsed }
}

export const readFlowPrompt = (
  args: FlowArgs,
  defaultPrompt?: string
): Effect.Effect<string, ScriptUsage> => {
  if (args.promptFile !== undefined) {
    return Effect.tryPromise({
      try: () => readFile(args.promptFile ?? "", "utf8"),
      catch: (error) =>
        ScriptUsage.make({
          message: `could not read prompt file ${args.promptFile}: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
    })
  }
  const prompt = args.promptText ?? defaultPrompt
  return prompt === undefined
    ? Effect.fail(ScriptUsage.make({ message: FlowUsage }))
    : Effect.succeed(prompt)
}

export const resolveFlowRepo = (
  args: FlowArgs,
  workspace: string
): Effect.Effect<string, ScriptUsage> => {
  const path = resolve(workspace, args.repo ?? ".")
  return Effect.tryPromise({
    try: async () => {
      const information = await stat(path)
      if (!information.isDirectory()) {
        throw new Error("not a directory")
      }
      return path
    },
    catch: (error) =>
      ScriptUsage.make({
        message: `--repo is not a directory: ${path}${
          error instanceof Error ? ` (${error.message})` : ""
        }`
      })
  })
}

export interface FlowInput {
  readonly prompt: string
  readonly workDir: string
  readonly workspace: string
}

export const resolveFlowInput = Effect.fn("@llm4ts/runner/FlowArgs.resolveFlowInput")(function* (
  defaultPrompt?: string,
  argv: ReadonlyArray<string> = process.argv.slice(2),
  workspace = process.cwd()
): Effect.fn.Return<FlowInput, ScriptUsage> {
  const parsed = parseFlowArgs(argv)
  if (!parsed.ok) {
    return yield* parsed.error
  }
  const prompt = yield* readFlowPrompt(parsed.value, defaultPrompt)
  const workDir = yield* resolveFlowRepo(parsed.value, workspace)
  return { prompt, workDir, workspace }
})
