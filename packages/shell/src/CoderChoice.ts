import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { connectorTable, offeredCoders } from "@llm4ts/core/Models"

/**
 * The coding agents a menu offers: the name written as `LLM4TS_CODER`, and
 * the executable its connector spawns. Both come from core's connector table.
 */
export interface CoderChoice {
  readonly token: string
  readonly executable: string
}

export const coderChoices: ReadonlyArray<CoderChoice> = offeredCoders.map((name) => ({
  token: connectorTable[name].names[0],
  executable: connectorTable[name].executable
}))

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
  const token = environment.LLM4TS_CODER ?? "claude"
  return coderChoices.some((choice) => choice.token === token) ? token : "claude"
}
