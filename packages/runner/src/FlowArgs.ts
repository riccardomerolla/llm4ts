import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export interface FlowArgs {
  readonly promptText?: string
  readonly promptFile?: string
  readonly repo?: string
}

export const FlowUsage =
  'usage: llm4ts ["<prompt>" | --prompt-file <path> | @<path>] [--repo <path>]'

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
