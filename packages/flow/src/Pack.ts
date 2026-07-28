import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Dimension } from "@llm4ts/core/eval/Eval"
import { PlanParseError } from "./FlowError.ts"
import { CoverageRule } from "./SpecChecks.ts"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

export const ComparisonOrdering = Schema.Literals(["Ordered", "Unordered", "PerKey"])
export type ComparisonOrdering = typeof ComparisonOrdering.Type

export class ComparisonPolicy extends Schema.Class<ComparisonPolicy>("ComparisonPolicy")({
  ordering: ComparisonOrdering,
  ignore: Schema.ReadonlySet(Schema.String)
}) {}

export class Reviewer extends Schema.Class<Reviewer>("Reviewer")({
  name: Schema.String,
  systemPrompt: Schema.String,
  files: Schema.optionalKey(Schema.String)
}) {
  matches(changedFiles: ReadonlyArray<string>): boolean {
    if (this.files === undefined || changedFiles.length === 0) {
      return true
    }
    const pattern = new RegExp(this.files)
    return changedFiles.some((path) => pattern.test(path))
  }
}

export const parseReviewer = (name: string, text: string): Reviewer => {
  const parts = text.split("---\n", 3)
  const frontmatter = parts.length === 3 ? (parts[1] ?? "") : ""
  const body = parts.length === 3 ? (parts[2] ?? "").trim() : text.trim()
  const files = frontmatter
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("files:"))
    ?.split("files:", 2)[1]
    ?.trim()
  return Reviewer.make({
    name,
    systemPrompt: body,
    ...(files === undefined || files.length === 0 ? {} : { files })
  })
}

export interface Pack {
  readonly name: string
  readonly source: string
  readonly scaffold: string | undefined
  readonly sources: string | undefined
  readonly programs: string | undefined
  readonly specsDir: string
  readonly featuresDir: string
  readonly gates: Readonly<Record<string, ReadonlyArray<string>>>
  readonly replay: ReadonlyArray<string> | undefined
  readonly equivalence: ComparisonPolicy
  readonly judgeDimensions: ReadonlyArray<Dimension>
  readonly coverage: ReadonlyArray<CoverageRule>
  readonly survey: ReadonlyArray<CoverageRule>
  readonly prompts: Readonly<Record<string, string>>
  readonly lenses: ReadonlyArray<Reviewer>
  readonly lessons: string | undefined
  readonly dir: string
  readonly gate: (name: string) => ReadonlyArray<string> | undefined
  readonly prompt: (name: string) => string | undefined
}

interface ParsedManifest {
  readonly name: string
  readonly fields: Readonly<Record<string, string>>
  readonly sections: ReadonlyArray<string>
}

const parseManifest = (markdown: string): Effect.Effect<ParsedManifest, PlanParseError> => {
  const chunks = markdown
    .trim()
    .split(/^(?=## )/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
  const head = chunks[0]
  const prefix = "# Pack: "
  if (head === undefined || !head.startsWith(prefix)) {
    return Effect.fail(
      PlanParseError.make({
        message: `expected a '${prefix}<name>' header`
      })
    )
  }
  const lines = head.split(/\r?\n/)
  const fields = Object.fromEntries(
    lines.slice(1).flatMap((line) => {
      const index = line.indexOf(":")
      return index < 0 || line.trim().startsWith("#") || line.trim().startsWith("-")
        ? []
        : [[line.slice(0, index).trim(), line.slice(index + 1).trim()]]
    })
  )
  return fields.source === undefined
    ? Effect.fail(
        PlanParseError.make({
          message: "pack manifest is missing a 'source:' field"
        })
      )
    : Effect.succeed({
        name: lines[0]?.slice(prefix.length).trim() ?? "",
        fields,
        sections: chunks.slice(1)
      })
}

const section = (sections: ReadonlyArray<string>, title: string): string | undefined =>
  sections
    .find((candidate) => candidate.split(/\r?\n/)[0]?.trim() === `## ${title}`)
    ?.split(/\r?\n/)
    .slice(1)
    .join("\n")
    .trim()

const namedItems = (body: string | undefined): Readonly<Record<string, string>> =>
  Object.fromEntries(
    (body ?? "").split(/\r?\n/).flatMap((line) => {
      const match = /^- ([^:]+): (.+)$/.exec(line)
      return match?.[1] === undefined || match[2] === undefined
        ? []
        : [[match[1].trim(), match[2].trim()]]
    })
  )

const rules = (sections: ReadonlyArray<string>, prefix: string): ReadonlyArray<CoverageRule> =>
  sections.flatMap((candidate) => {
    const lines = candidate.split(/\r?\n/)
    const heading = lines[0]?.trim() ?? ""
    if (!heading.startsWith(prefix)) {
      return []
    }
    const fields = Object.fromEntries(
      lines.slice(1).flatMap((line) => {
        const index = line.indexOf(":")
        return index < 0 ? [] : [[line.slice(0, index).trim(), line.slice(index + 1).trim()]]
      })
    )
    return fields.files === undefined || fields.unit === undefined
      ? []
      : [
          CoverageRule.make({
            name: heading.slice(prefix.length).trim(),
            files: fields.files,
            unit: fields.unit
          })
        ]
  })

const dimensions = (body: string | undefined): ReadonlyArray<Dimension> =>
  (body ?? "").split(/\r?\n/).flatMap((line) => {
    const match = /^- ([^(]+)\(0\.\.(\d+)\): (.+)$/.exec(line)
    const name = match?.[1]?.trim()
    const maxScore = Number.parseInt(match?.[2] ?? "", 10)
    const rubric = match?.[3]?.trim()
    return name === undefined || rubric === undefined || !Number.isInteger(maxScore)
      ? []
      : [Dimension.make({ name, rubric, maxScore })]
  })

const markdownSidecars = Effect.fn("@llm4ts/flow/Pack.markdownSidecars")(function* (
  workspace: WorkspaceShape,
  directory: string
): Effect.fn.Return<Readonly<Record<string, string>>, WorkspaceError> {
  const paths = yield* workspace.discover(`${directory}/*.md`)
  const entries: Array<readonly [string, string]> = []
  for (const path of paths) {
    const file = path.split("/").at(-1) ?? path
    entries.push([file.replace(/\.md$/, ""), (yield* workspace.read(path)).trim()])
  }
  return Object.fromEntries(entries)
})

export const loadPack = Effect.fn("@llm4ts/flow/Pack.load")(function* (
  workspace: WorkspaceShape,
  directory: string
): Effect.fn.Return<Pack, WorkspaceError | PlanParseError> {
  const manifest = yield* parseManifest(yield* workspace.read(`${directory}/pack.md`))
  const prompts = yield* markdownSidecars(workspace, `${directory}/prompts`)
  const lensFiles = yield* markdownSidecars(workspace, `${directory}/reviewers`)
  const lessons = yield* workspace.read(`${directory}/lessons.md`).pipe(
    Effect.map((text) => text.trim()),
    Effect.catch(() => Effect.succeed(undefined))
  )
  const gateValues = namedItems(section(manifest.sections, "Gates"))
  const equivalenceValues = namedItems(section(manifest.sections, "Equivalence"))
  const ordering: ComparisonOrdering =
    equivalenceValues.ordering?.toLowerCase() === "unordered"
      ? "Unordered"
      : equivalenceValues.ordering?.toLowerCase() === "per-key"
        ? "PerKey"
        : "Ordered"
  const gates = Object.fromEntries(
    Object.entries(gateValues).map(([name, command]) => [name, command.split(/\s+/)])
  )
  const lenses = Object.entries(lensFiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, text]) => parseReviewer(name, text))
  const fields = manifest.fields
  const pack: Pack = {
    name: manifest.name,
    source: fields.source ?? "",
    scaffold: fields.scaffold,
    sources: fields.sources,
    programs: fields.programs,
    specsDir: fields["specs-dir"] ?? "docs/specs",
    featuresDir: fields["features-dir"] ?? "features",
    gates,
    replay: fields.replay?.split(/\s+/),
    equivalence: ComparisonPolicy.make({
      ordering,
      ignore: new Set(
        (equivalenceValues.ignore ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      )
    }),
    judgeDimensions: dimensions(section(manifest.sections, "Judge")),
    coverage: rules(manifest.sections, "## Coverage: "),
    survey: rules(manifest.sections, "## Survey: "),
    prompts,
    lenses,
    lessons: lessons === undefined || lessons.length === 0 ? undefined : lessons,
    dir: directory,
    gate: (name) => gates[name],
    prompt: (name) => prompts[name]
  }
  return pack
})

export const appendPackLesson = (
  workspace: WorkspaceShape,
  directory: string,
  lesson: string
): Effect.Effect<void, WorkspaceError> =>
  workspace.append(`${directory}/lessons.md`, `- ${lesson.trim()}\n`)
