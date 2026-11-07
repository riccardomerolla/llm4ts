import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { builtinTools } from "@llm4ts/flow/tools/Builtin"
import type { ToolReport, ToolSpec } from "@llm4ts/flow/tools/Tool"
import { isToolName, renderUsage, specOf, type ToolShape } from "@llm4ts/flow/tools/Tool"
import type { ToolPreset } from "@llm4ts/flow/Pack"
import type { DiscoveredKit } from "./Kits.ts"

/**
 * The tool catalog (ADR 0048): the built-in tools, every discovered kit's
 * `tools/<name>.ts`, and the presets of the packs in reach. A kit tool with
 * a built-in's name shadows it, project kits first, as flows do.
 */
export type CatalogEntry =
  | { readonly _tag: "builtin"; readonly name: string; readonly tool: ToolShape }
  | {
      readonly _tag: "kit"
      readonly name: string
      readonly kit: DiscoveredKit
      readonly file: string
    }

export interface ToolCatalog {
  readonly entries: ReadonlyArray<CatalogEntry>
  readonly presets: ReadonlyArray<ToolPreset & { readonly pack: string }>
}

const tierRank = { project: 0, global: 1, builtin: 2 } as const

export const catalogEntries = (kits: ReadonlyArray<DiscoveredKit>): ReadonlyArray<CatalogEntry> => {
  const byName = new Map<string, CatalogEntry>()
  for (const tool of builtinTools) {
    byName.set(tool.name, { _tag: "builtin", name: tool.name, tool })
  }
  const ordered = [...kits].sort((left, right) => tierRank[right.tier] - tierRank[left.tier])
  for (const kit of ordered) {
    for (const name of kit.tools) {
      if (!isToolName(name)) {
        continue
      }
      const file = ["ts", "js"]
        .map((extension) => join(kit.root, "tools", `${name}.${extension}`))
        .find((candidate) => existsSync(candidate))
      if (file !== undefined) {
        byName.set(name, { _tag: "kit", name, kit, file })
      }
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export const findEntry = (
  catalog: ReadonlyArray<CatalogEntry>,
  name: string
): CatalogEntry | undefined => catalog.find((entry) => entry.name === name)

/**
 * A preset is `tool --flag value …`: the catalog tool, then its arguments,
 * with whatever the caller appends. A preset never names another preset.
 */
export interface ResolvedPreset {
  readonly preset: ToolPreset & { readonly pack: string }
  readonly entry: CatalogEntry
  readonly argv: ReadonlyArray<string>
}

export class PresetError extends Schema.TaggedError<PresetError>()("PresetError", {
  preset: Schema.String,
  message: Schema.String
}) {}

export const resolvePreset = (
  catalog: ToolCatalog,
  name: string,
  extra: ReadonlyArray<string>
): Effect.Effect<ResolvedPreset | undefined, PresetError> => {
  const preset = catalog.presets.find((candidate) => candidate.name === name)
  if (preset === undefined) {
    return Effect.succeed(undefined)
  }
  const [toolName, ...rest] = preset.command
  if (toolName === undefined) {
    return Effect.fail(new PresetError({ preset: name, message: "preset names no tool" }))
  }
  const entry = findEntry(catalog.entries, toolName)
  if (entry === undefined) {
    return Effect.fail(
      new PresetError({
        preset: name,
        message: `preset runs '${toolName}', which is not a catalog tool (run \`llm4ts tool list\`)`
      })
    )
  }
  return Effect.succeed({ preset, entry, argv: [...rest, ...extra] })
}

/**
 * The repository a worktree belongs to: `git rev-parse --git-common-dir`
 * points back at the main checkout from any worktree, so the project tier
 * (`<repo>/.llm4ts/kits`) is found without a file in the worktree or an
 * environment variable the executor would strip (ADR 0048). Falls back to
 * `cwd` outside a repository.
 */
export const projectRootOf = (cwd: string): string => {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
    if (common.length === 0) {
      return cwd
    }
    const absolute = isAbsolute(common) ? common : resolve(cwd, common)
    return dirname(absolute)
  } catch {
    return cwd
  }
}

/** One line per catalog entry and preset, for `llm4ts tool list`. */
export const renderCatalog = (
  catalog: ToolCatalog,
  specs: ReadonlyMap<string, ToolSpec>
): string => {
  const lines: Array<string> = []
  for (const entry of catalog.entries) {
    const spec = specs.get(entry.name)
    const origin = entry._tag === "builtin" ? "" : ` [${entry.kit.name} kit]`
    lines.push(
      spec === undefined
        ? `${entry.name}${origin}`
        : `${renderUsage(spec)}${origin}\n    ${spec.purpose}`
    )
  }
  if (catalog.presets.length > 0) {
    lines.push("", "Presets (pack: command):")
    for (const preset of catalog.presets) {
      lines.push(`  ${preset.name} (${preset.pack}): ${preset.command.join(" ")}`)
    }
  }
  return lines.join("\n")
}

export const catalogJson = (
  catalog: ToolCatalog,
  specs: ReadonlyMap<string, ToolSpec>
): typeof Schema.Json.Type => ({
  tools: catalog.entries.map((entry) => {
    const spec = specs.get(entry.name)
    return {
      name: entry.name,
      origin: entry._tag === "builtin" ? "builtin" : `kit:${entry.kit.name}`,
      ...(spec === undefined ? {} : { purpose: spec.purpose, usage: renderUsage(spec) })
    }
  }),
  presets: catalog.presets.map((preset) => ({
    name: preset.name,
    pack: preset.pack,
    command: preset.command.join(" ")
  }))
})

/** Exit status for a report: 0 ok, 1 issues. Errors exit 2 (the CLI's own). */
export const reportExitCode = (report: ToolReport): number => (report.ok ? 0 : 1)

/**
 * The paragraph a coder's brief carries (ADR 0048): one rule, then each
 * preset of the story's pack with the command to run. `LLM4TS_TOOL_BRIEF=off`
 * drops it, for a run without the catalog to compare against.
 */
export const toolBrief = (
  presets: ReadonlyArray<ToolPreset>,
  specs: ReadonlyMap<string, ToolSpec>,
  environment: Readonly<Record<string, string | undefined>> = process.env
): string | undefined => {
  if (environment.LLM4TS_TOOL_BRIEF?.trim().toLowerCase() === "off") {
    return undefined
  }
  const lines = [
    "Tools: for validating a document, comparing two outputs, or checking a contract, run the",
    "project's tool instead of writing a script — `llm4ts tool <name> [--flag value]` prints JSON",
    "(ok, summary, issues). `llm4ts tool list` shows every tool; `llm4ts tool describe <name>`",
    "its arguments. Never write a Python or Node one-liner for a job a tool covers."
  ]
  if (presets.length > 0) {
    lines.push("", "This pack's presets (run them by name from the worktree root):")
    for (const preset of presets) {
      const [toolName, ...rest] = preset.command
      const spec = toolName === undefined ? undefined : specs.get(toolName)
      const fixed = rest.length === 0 ? "" : ` (fixed: ${rest.join(" ")})`
      const purpose = spec === undefined ? "" : ` — ${spec.purpose}`
      lines.push(`- \`llm4ts tool ${preset.name}\`${fixed}${purpose}`)
    }
  }
  return lines.join("\n")
}

/** Specs of the built-in tools, known without running anything. */
export const builtinSpecs = (): ReadonlyMap<string, ToolSpec> =>
  new Map(builtinTools.map((tool) => [tool.name, specOf(tool)]))
