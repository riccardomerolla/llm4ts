// Shared by the port flows (ADR 0028): the pack as a porting pack, the
// manifest of sources and their targets, the rulebook and pitfall cards
// the implementer reads, and the prompts. The seats and the queue are the
// flows' own business.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { autonomyContract } from "@llm4ts/flow/AutonomyContract"
import { cap } from "@llm4ts/flow/Context"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import type { Pack } from "@llm4ts/flow/Pack"
import { loadPatternCards } from "@llm4ts/flow/Patterns"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { PortEntry, linesOf, portStatusInstruction, targetPathOf } from "@llm4ts/flow/Port"
import { matchingFiles } from "@llm4ts/flow/SpecChecks"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import type { OpenedPack } from "@llm4ts/runner/Packs"

/** Where the port flows keep their state, under the target repository. */
export const portStateDir = (workDir: string): string => join(workDir, ".llm4ts", "port")

export interface PortingPack {
  readonly pack: Pack
  readonly target: string
  readonly comment: string
  readonly rulebook: string
  /** The pitfall cards (`patterns/pitfalls-*.md`), rendered for a prompt; empty when the pack has none. */
  readonly pitfalls: string
}

export const defaultRulebook = [
  "You translate one source file to its target language, faithfully and mechanically:",
  "the same structure, the same names, the same control flow, so a reviewer can read source",
  "and target side by side. Translate what the source does, never what you think it should",
  "do. Flag anything you cannot translate confidently with a TODO(port): <reason> comment",
  "instead of guessing: a flag is better than wrong code."
].join("\n")

/** The pack read as a porting pack: `target:` is required, the rulebook is `prompts/porting.md`. */
export const asPortingPack = Effect.fn("port.asPortingPack")(function* (
  opened: OpenedPack
): Effect.fn.Return<PortingPack, FlowError> {
  const pack = opened.pack
  if (pack.target === undefined) {
    return yield* FlowAborted.make({
      message: `pack '${pack.name}' has no 'target:' template (e.g. target: {{dir}}/{{base}}.rs); it is not a porting pack`
    })
  }
  const cards = yield* loadPatternCards(opened.workspace, `${opened.dir}/patterns`)
  const pitfalls = cards
    .filter((card) => card.id.startsWith("pitfalls"))
    .map((card) => `### ${card.id}\n${card.body.trim()}`)
    .join("\n\n")
  return {
    pack,
    target: pack.target,
    comment: pack.comment ?? "//",
    rulebook: pack.prompt("porting") ?? defaultRulebook,
    pitfalls
  }
})

/** Every source the pack matches, with its line count and target; sorted by path. */
export const portManifest = Effect.fn("port.manifest")(function* (
  repo: WorkspaceShape,
  files: PlainFileStoreShape,
  workDir: string,
  porting: PortingPack
): Effect.fn.Return<ReadonlyArray<PortEntry>, FlowError> {
  const sources = yield* matchingFiles(repo, porting.pack.sources ?? "(?!)", porting.pack.exclude)
  const entries: Array<PortEntry> = []
  for (const source of sources) {
    const text = (yield* files.read(join(workDir, source))) ?? ""
    entries.push(
      PortEntry.make({
        id: source,
        source,
        target: targetPathOf(porting.target, source),
        loc: linesOf(text)
      })
    )
  }
  return entries
})

/** The denials that keep an implementer on its one file (the Bun port's prompt, in spirit). */
export const implementerDenials = [
  "Read exactly one source file: the one named below. Do NOT read other source files for",
  "context: the rulebook's maps are authoritative for cross-file references. Do NOT run a",
  "build, a test or any git command: the flow builds and commits. Write only the target file.",
  "Match the source's structure: same function names, same field order, same control flow."
].join("\n")

export const implementerSystem = (porting: PortingPack): string =>
  [
    autonomyContract("minimal"),
    "",
    "# Porting rulebook",
    porting.rulebook,
    ...(porting.pitfalls.length === 0
      ? []
      : ["", "# Pitfalls: syntactically alike, semantically different", porting.pitfalls]),
    "",
    implementerDenials
  ].join("\n")

export const implementerPrompt = (
  entry: PortEntry,
  sourceText: string,
  porting: PortingPack,
  sourceChars: number
): string =>
  [
    `Port \`${entry.source}\` (${entry.loc} lines). Write the ported file at: ${entry.target}`,
    "The draft need not compile; it must capture the logic faithfully.",
    "",
    portStatusInstruction(porting.comment),
    "",
    `Source file \`${entry.source}\`:`,
    "```",
    cap(sourceText, sourceChars).text,
    "```"
  ].join("\n")

/** The fixer's brief for a drafted file: apply findings against the source, nothing else. */
export const portFixerSystem = (porting: PortingPack): string =>
  [
    autonomyContract("minimal"),
    "",
    "You apply review findings to a ported file another coder drafted. Apply the findings and",
    "nothing else; where a finding conflicts with the source file's behaviour, the source wins.",
    "Keep the PORT STATUS trailer at the end and update its confidence and todos honestly.",
    "If a finding is wrong (the reviewer misread the code), skip it and say so in one line.",
    "",
    "# Porting rulebook",
    porting.rulebook
  ].join("\n")

/** The compile fixer's brief: one unit, its diagnostics, no build, no git. */
export const compileFixerSystem = (porting: PortingPack): string =>
  [
    autonomyContract("minimal"),
    "",
    "You fix compiler diagnostics in ONE unit of a mechanically ported code base. Edit only the",
    "files the diagnostics name and their unit. Other units are being fixed by other coders at",
    "the same time: a broken import from another unit is EXPECTED, leave it. Do NOT run a build",
    "or any git command: the flow rebuilds once per round and commits. Never stub a function,",
    "weaken a type to `any` or its equivalent, or add a comment explaining why a workaround is",
    "acceptable: if the fix needs a paragraph of justification, the fix is wrong. Where a fix",
    "needs another unit to change, skip it and say which unit in one line.",
    "",
    "# Porting rulebook",
    porting.rulebook
  ].join("\n")

export const portEnv = (
  environment: Readonly<Record<string, string | undefined>>
): {
  readonly pilot: number
  readonly concurrency: number
  readonly batch: number
  readonly votes: number
  readonly sourceChars: number
} => {
  const int = (raw: string | undefined, fallback: number, min = 1): number => {
    const value = Number.parseInt(raw ?? "", 10)
    return Number.isFinite(value) && value >= min ? value : fallback
  }
  return {
    pilot: int(environment.LLM4TS_PORT_PILOT, 0, 1),
    concurrency: int(environment.LLM4TS_PORT_CONCURRENCY, 4),
    batch: int(environment.LLM4TS_PORT_BATCH, 100),
    votes: int(environment.LLM4TS_REVIEW_VOTES, 2),
    sourceChars: int(environment.LLM4TS_PORT_SOURCE_CHARS, 120_000, 1_000)
  }
}
