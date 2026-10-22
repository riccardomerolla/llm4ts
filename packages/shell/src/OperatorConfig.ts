import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ShellUsageError } from "./ShellErrors.ts"

export interface McpFlags {
  readonly stdio: boolean
  readonly http: boolean
  readonly host: Option.Option<string>
  readonly port: Option.Option<number>
  readonly tokenFile: Option.Option<string>
  readonly repo: ReadonlyArray<string>
  readonly allowRun: boolean
  readonly allowApprove: boolean
  readonly parallelRuns: Option.Option<number>
}

export interface OperatorConfig {
  readonly transport:
    | { readonly _tag: "stdio" }
    | {
        readonly _tag: "http"
        readonly host: string
        readonly port: number
        readonly token: string
      }
  readonly repos: ReadonlyArray<{ readonly id: string; readonly path: string }>
  readonly allowRun: boolean
  readonly allowApprove: boolean
  readonly parallelRuns: number
}

export const McpConfigFile = Schema.Struct({
  repos: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String }))
})

const usage = (message: string): ShellUsageError => new ShellUsageError({ message })

/**
 * Turns the `mcp` flags into the operator configuration. The token is read from the
 * environment or a file and is never echoed in an error message.
 */
export const mcpOptionsFrom = (
  flags: McpFlags,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  readFile: (path: string) => Effect.Effect<string | undefined>
): Effect.Effect<OperatorConfig, ShellUsageError> =>
  Effect.gen(function* () {
    if (flags.stdio && flags.http) {
      return yield* usage("mcp takes either --stdio or --http, not both")
    }
    const parallelRuns = Option.getOrElse(flags.parallelRuns, () => 1)
    if (!Number.isInteger(parallelRuns) || parallelRuns < 1) {
      return yield* usage("--parallel-runs must be a positive integer")
    }

    const transport = flags.http ? yield* httpTransport(flags, environment, cwd, readFile) : stdio

    const repos = yield* reposFrom(flags, environment, cwd, readFile)
    const seen = new Set<string>()
    for (const repo of repos) {
      if (seen.has(repo.id)) {
        return yield* usage(`mcp repository id "${repo.id}" is used twice`)
      }
      seen.add(repo.id)
    }

    return {
      transport,
      repos,
      allowRun: flags.allowRun,
      allowApprove: flags.allowApprove,
      parallelRuns
    }
  })

const stdio: OperatorConfig["transport"] = { _tag: "stdio" }

const httpTransport = (
  flags: McpFlags,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  readFile: (path: string) => Effect.Effect<string | undefined>
): Effect.Effect<OperatorConfig["transport"], ShellUsageError> =>
  Effect.gen(function* () {
    const fromEnvironment = environment.LLM4TS_MCP_TOKEN?.trim() ?? ""
    const fromFile =
      fromEnvironment.length === 0 && Option.isSome(flags.tokenFile)
        ? ((yield* readFile(resolve(cwd, flags.tokenFile.value)))?.trim() ?? "")
        : ""
    const token = fromEnvironment.length > 0 ? fromEnvironment : fromFile
    if (token.length === 0) {
      return yield* usage("--http needs a token: LLM4TS_MCP_TOKEN or --token-file")
    }
    const port = Option.getOrElse(flags.port, () => 4321)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return yield* usage("--port must be between 0 and 65535")
    }
    return {
      _tag: "http" as const,
      host: Option.getOrElse(flags.host, () => "127.0.0.1"),
      port,
      token
    }
  })

const reposFrom = (
  flags: McpFlags,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  readFile: (path: string) => Effect.Effect<string | undefined>
): Effect.Effect<OperatorConfig["repos"], ShellUsageError> =>
  Effect.gen(function* () {
    if (flags.repo.length > 0) {
      return flags.repo.map((path) => {
        const absolute = resolve(cwd, path)
        return { id: basename(absolute), path: absolute }
      })
    }
    const configHome =
      environment.XDG_CONFIG_HOME !== undefined && environment.XDG_CONFIG_HOME.length > 0
        ? environment.XDG_CONFIG_HOME
        : join(environment.HOME ?? homedir(), ".config")
    const configPath = join(configHome, "llm4ts", "mcp.json")
    const raw = yield* readFile(configPath)
    if (raw === undefined) {
      return yield* usage("mcp needs --repo <path> or ~/.config/llm4ts/mcp.json")
    }
    const file = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(McpConfigFile))(raw).pipe(
      Effect.mapError(() => usage(`${configPath} is not a valid mcp config`))
    )
    if (file.repos.length === 0) {
      return yield* usage("mcp needs --repo <path> or ~/.config/llm4ts/mcp.json")
    }
    return file.repos.map(({ id, path }) => ({ id, path: resolve(cwd, path) }))
  })
