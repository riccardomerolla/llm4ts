import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

/**
 * The coder tokens `coderFromEnv` accepts as `LLM4TS_CODER` values, each with
 * the executable name the corresponding CLI connector spawns. The tokens are
 * the connector identity vocabulary of `@llm4ts/core/Models` narrowed to the
 * CLI coding agents the runner exposes.
 */
export interface CoderChoice {
  readonly token: string
  readonly executable: string
}

export const coderChoices: ReadonlyArray<CoderChoice> = [
  { token: "claude", executable: "claude" },
  { token: "codex", executable: "codex" },
  { token: "gemini", executable: "gemini" },
  { token: "pi", executable: "pi" },
  { token: "agy", executable: "agy" },
  { token: "grok", executable: "grok" },
  { token: "cursor", executable: "cursor-agent" },
  { token: "opencode", executable: "opencode" }
]

/**
 * Locates an executable on `PATH` without spawning a process. Decoration
 * only: an undetected CLI stays selectable, mirroring orca's wizard probing.
 */
export const findOnPath = (
  executable: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): string | undefined => {
  const searchPath = environment.PATH
  if (searchPath === undefined || searchPath.length === 0) {
    return undefined
  }
  for (const directory of searchPath.split(delimiter)) {
    if (directory.length === 0) {
      continue
    }
    const candidate = join(directory, executable)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

export const resolvedCoderToken = (
  environment: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const token = environment.LLM4TS_CODER ?? environment.LLM4ZIO_CODER ?? "claude"
  return coderChoices.some((choice) => choice.token === token) ? token : "claude"
}
