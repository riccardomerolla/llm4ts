import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

type Environment = Readonly<Record<string, string | undefined>>

const set = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined

/** `${XDG_STATE_HOME:-~/.local/state}/llm4ts`: state that must outlive, and stay outside, a checkout. */
export const stateHome = (environment: Environment): string =>
  join(
    set(environment.XDG_STATE_HOME) ?? join(set(environment.HOME) ?? homedir(), ".local", "state"),
    "llm4ts"
  )

/**
 * A checkout's name in that state: its directory name and eight hex
 * characters of the SHA-256 of its real path, so two checkouts with one name
 * never share state.
 */
export const checkoutKey = (workDir: string): string => {
  let real = resolve(workDir)
  try {
    real = realpathSync(real)
  } catch {
    // not on disk (yet): the resolved path names it
  }
  const name = basename(real).replace(/[^A-Za-z0-9._-]/g, "_")
  return `${name}-${createHash("sha256").update(real).digest("hex").slice(0, 8)}`
}

/** The directory of a checkout's control logs, one file per epic (ADR 0057). */
export const controlRoot = (environment: Environment, workDir: string): string =>
  join(stateHome(environment), "control", checkoutKey(workDir))
