import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Argument, Command, Flag } from "effect/cli"
import type { ToolPreset } from "@llm4ts/flow/Pack"
import type { ToolArgsError } from "@llm4ts/flow/tools/Tool"
import {
  ToolError,
  ToolReport,
  ToolSpec,
  capReport,
  parseToolArgs,
  renderReport,
  renderSpec,
  specOf
} from "@llm4ts/flow/tools/Tool"
import {
  builtinKitsDir,
  discoverKits,
  kitTierPaths,
  type DiscoveredKit,
  type KitTierPaths
} from "@llm4ts/runner/Kits"
import * as Layer from "effect/Layer"
import { SoapTransport, makeNodeSoapTransport } from "@llm4ts/flow/endpoint/Transport"
import { ToolContext } from "@llm4ts/flow/tools/Tool"
import { NodePlainFileStoreLive } from "@llm4ts/runner/NodePlainFileStore"
import { openPack } from "@llm4ts/runner/Packs"
import { ChildToolOutput } from "@llm4ts/runner/ToolMain"
import {
  PresetError,
  builtinSpecs,
  catalogEntries,
  catalogJson,
  findEntry,
  projectRootOf,
  renderCatalog,
  reportExitCode,
  resolvePreset,
  type CatalogEntry,
  type ToolCatalog
} from "@llm4ts/runner/Tools"
import { flowNodeArgs } from "./FlowProcess.ts"
import { ShellUsageError } from "./ShellErrors.ts"

/**
 * `llm4ts tool list | describe <name> | run <name> [args]` (ADR 0048): the
 * one subcommand a coding agent may run inside a task. The project is found
 * from the worktree through git, never through `LLM4TS_*` variables.
 */

export class ToolChildError extends Schema.TaggedError<ToolChildError>()("ToolChildError", {
  tool: Schema.String,
  message: Schema.String
}) {}

// The same directory `Cli.ts` computes; repeated here so this module does not
// import the command module that imports it.
const builtinFlowsDir = (): string => fileURLToPath(new URL("../flows", import.meta.url))

const kitTiersFor = (root: string): KitTierPaths => {
  const builtin = builtinKitsDir(builtinFlowsDir())
  return kitTierPaths({
    cwd: root,
    homeDir: homedir(),
    ...(builtin === undefined ? {} : { builtinDir: builtin })
  })
}

const loadCatalog = (packReference: string | undefined): Effect.Effect<ToolCatalog, never> =>
  Effect.gen(function* () {
    const root = projectRootOf(process.cwd())
    const tiers = kitTiersFor(root)
    const kits = discoverKits(tiers)
    const entries = catalogEntries(kits)
    const presets = yield* presetsOf(kits, root, packReference, tiers)
    return { entries, presets }
  })

const presetsOf = (
  kits: ReadonlyArray<DiscoveredKit>,
  root: string,
  packReference: string | undefined,
  kitTiers: KitTierPaths
): Effect.Effect<ReadonlyArray<ToolPreset & { readonly pack: string }>, never> =>
  Effect.gen(function* () {
    const references =
      packReference !== undefined
        ? [packReference]
        : kits.flatMap((kit) => kit.packs.map((pack) => `${kit.name}/${pack}`))
    const presets: Array<ToolPreset & { readonly pack: string }> = []
    for (const reference of references) {
      const opened = yield* openPack({
        environment: { LLM4TS_PACK: reference },
        launchDir: root,
        flowDir: builtinFlowsDir(),
        kits: kitTiers
      }).pipe(Effect.option)
      if (opened._tag === "Some") {
        for (const preset of opened.value.pack.tools ?? []) {
          presets.push({ ...preset, pack: opened.value.pack.name })
        }
      }
    }
    return presets
  })

/** A kit tool runs as a Node child speaking the `runToolMain` protocol. */
const runChild = (
  file: string,
  args: ReadonlyArray<string>,
  stdin: string | undefined
): Effect.Effect<
  { readonly stdout: string; readonly stderr: string; readonly code: number },
  never
> =>
  Effect.callback((resume) => {
    const child = spawn(process.execPath, [...flowNodeArgs(file), file, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env }
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (stdout += chunk))
    child.stderr.on("data", (chunk: string) => (stderr += chunk))
    child.on("error", (error) => resume(Effect.succeed({ stdout, stderr: error.message, code: 2 })))
    child.on("close", (code) => resume(Effect.succeed({ stdout, stderr, code: code ?? 2 })))
    if (stdin !== undefined) {
      child.stdin.write(stdin)
    }
    child.stdin.end()
    return Effect.sync(() => child.kill())
  })

const decodeChildJson = <A, E, RD>(
  schema: Schema.Codec<A, E, RD>,
  tool: string,
  output: { readonly stdout: string; readonly stderr: string }
): Effect.Effect<A, ToolChildError, RD> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(output.stdout.trim()).pipe(
    Effect.mapError(
      () =>
        new ToolChildError({
          tool,
          message: `tool printed no report${output.stderr.trim().length === 0 ? "" : `: ${output.stderr.trim()}`}`
        })
    )
  )

const specFor = (entry: CatalogEntry): Effect.Effect<ToolSpec, ToolChildError> =>
  entry._tag === "builtin"
    ? Effect.succeed(specOf(entry.tool))
    : Effect.flatMap(runChild(entry.file, ["--describe"], undefined), (output) =>
        decodeChildJson(ToolSpec, entry.name, output)
      )

const toolLayer = (projectRoot: string) =>
  Layer.mergeAll(
    NodePlainFileStoreLive,
    Layer.succeed(ToolContext)({ projectRoot, environment: process.env }),
    Layer.succeed(SoapTransport)(makeNodeSoapTransport())
  )

const execute = (
  entry: CatalogEntry,
  values: Record<string, unknown>,
  projectRoot: string
): Effect.Effect<ToolReport, ToolError | ToolArgsError | ToolChildError> =>
  entry._tag === "builtin"
    ? entry.tool.execute(values).pipe(Effect.provide(toolLayer(projectRoot)))
    : Effect.gen(function* () {
        const output = yield* runChild(
          entry.file,
          ["--project", projectRoot],
          JSON.stringify(values)
        )
        const decoded = yield* decodeChildJson(ChildToolOutput, entry.name, output)
        return "error" in decoded
          ? yield* new ToolError({ tool: entry.name, message: decoded.error })
          : decoded
      })

const specsOf = (
  catalog: ToolCatalog,
  describeKits: boolean
): Effect.Effect<ReadonlyMap<string, ToolSpec>, never> =>
  Effect.gen(function* () {
    const specs = new Map(builtinSpecs())
    if (describeKits) {
      for (const entry of catalog.entries) {
        if (entry._tag === "kit") {
          const spec = yield* specFor(entry).pipe(Effect.option)
          if (spec._tag === "Some") {
            specs.set(entry.name, spec.value)
          }
        }
      }
    }
    return specs
  })

const packFlag = Flag.String("pack").pipe(
  Flag.optional,
  Flag.withDescription(
    "Only this pack's presets (kit/pack, a name, or a path); default: every pack in reach"
  )
)

const listCommand = Command.make(
  "list",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Emit the catalog as JSON")
    ),
    pack: packFlag
  },
  (config) =>
    Effect.gen(function* () {
      const catalog = yield* loadCatalog(
        config.pack._tag === "Some" ? config.pack.value : undefined
      )
      const specs = yield* specsOf(catalog, true)
      yield* Console.log(
        config.json
          ? JSON.stringify(catalogJson(catalog, specs), null, 2)
          : renderCatalog(catalog, specs)
      )
    })
).pipe(Command.withDescription("List the tools and presets this project can run"))

const describeCommand = Command.make(
  "describe",
  {
    name: Argument.String("name").pipe(Argument.withDescription("A tool or preset name")),
    pack: packFlag
  },
  (config) =>
    Effect.gen(function* () {
      const catalog = yield* loadCatalog(
        config.pack._tag === "Some" ? config.pack.value : undefined
      )
      const resolved = yield* resolvePreset(catalog, config.name, [])
      const entry = resolved?.entry ?? findEntry(catalog.entries, config.name)
      if (entry === undefined) {
        return yield* new ShellUsageError({
          message: `no tool or preset named '${config.name}'; run \`llm4ts tool list\``
        })
      }
      const spec = yield* specFor(entry)
      const header =
        resolved === undefined
          ? []
          : [
              `${config.name}: preset of pack ${resolved.preset.pack} — runs \`${resolved.preset.command.join(" ")}\``,
              ""
            ]
      yield* Console.log([...header, renderSpec(spec)].join("\n"))
    })
).pipe(Command.withDescription("Show a tool's purpose and arguments"))

/**
 * `tool run <name> …` takes the tool's own `--flag value` pairs, which a
 * declared command would reject as unknown options, so `runShellCommand`
 * routes it here before `effect/cli` parses anything. `--all`, `--text` and
 * `--pack <ref>` are picked out; everything else goes to the tool.
 */
export const runToolRun = (
  name: string,
  argv: ReadonlyArray<string>
): Effect.Effect<void, ShellUsageError> =>
  Effect.gen(function* () {
    let all = false
    let text = false
    let pack: string | undefined
    const rest: Array<string> = []
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index] ?? ""
      if (token === "--all") all = true
      else if (token === "--text") text = true
      else if (token === "--pack" && index + 1 < argv.length) {
        pack = argv[index + 1]
        index += 1
      } else if (token.startsWith("--pack=")) pack = token.slice("--pack=".length)
      else rest.push(token)
    }
    const projectRoot = projectRootOf(process.cwd())
    const catalog = yield* loadCatalog(pack)
    const resolved = yield* resolvePreset(catalog, name, rest)
    const entry = resolved?.entry ?? findEntry(catalog.entries, name)
    if (entry === undefined) {
      return yield* new ShellUsageError({
        message: `no tool or preset named '${name}'; run \`llm4ts tool list\``
      })
    }
    const spec = yield* specFor(entry)
    const values = yield* parseToolArgs(spec, resolved?.argv ?? rest)
    const report = capReport(yield* execute(entry, values, projectRoot), all)
    yield* Console.log(
      text ? renderReport(report) : JSON.stringify(Schema.encodeSync(ToolReport)(report))
    )
    process.exitCode = reportExitCode(report)
  }).pipe(
    Effect.catchTags({
      ToolArgsError: (error) => Effect.fail(new ShellUsageError({ message: error.message })),
      PresetError: (error) =>
        Effect.fail(new ShellUsageError({ message: `${error.preset}: ${error.message}` })),
      ToolError: (error) =>
        Effect.fail(new ShellUsageError({ message: `${error.tool}: ${error.message}` })),
      ToolChildError: (error) =>
        Effect.fail(new ShellUsageError({ message: `${error.tool}: ${error.message}` }))
    })
  )

// Declared for `--help` only: `runShellCommand` hands `tool run` to
// `runToolRun` with the raw arguments before this parser sees them.
const runCommand = Command.make(
  "run",
  {
    name: Argument.String("name").pipe(Argument.withDescription("A tool or preset name")),
    args: Argument.String("args").pipe(
      Argument.variadic(),
      Argument.withDescription(
        "The tool's --flag value pairs (a preset's fixed ones come first); --all prints every issue, --text plain text, --pack <ref> one pack's presets"
      )
    )
  },
  (config) => runToolRun(config.name, config.args)
).pipe(Command.withDescription("Run a tool or preset; JSON report on stdout, exit 1 on issues"))

export const toolCommand = Command.make("tool", {}, () =>
  Effect.fail(
    new ShellUsageError({
      message: "try `llm4ts tool list`, `llm4ts tool describe <name>` or `llm4ts tool run <name>`"
    })
  )
).pipe(
  Command.withDescription(
    "Run the project's tools — validate, compare, check — instead of improvising a script (ADR 0048)"
  ),
  Command.withSubcommands([listCommand, describeCommand, runCommand])
)

export { PresetError }
