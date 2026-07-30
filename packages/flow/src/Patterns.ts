import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { WorkspaceError, WorkspaceShape } from "./Workspace.ts"

/**
 * One reusable modernization pattern: a legacy idiom, its target translation,
 * and the known traps — knowledge as data, like packs and lessons, but
 * universal and curated rather than estate-local and run-accumulated.
 * `matches` is a regex over legacy source: extraction tags each program's
 * traceability fragment with the ids of the cards that hit, and implementation
 * injects only the cited cards into the coder's brief — deterministic
 * selection, bounded context.
 */
export class PatternCard extends Schema.Class<PatternCard>("PatternCard")({
  id: Schema.String,
  matches: Schema.String,
  body: Schema.String
}) {}

const frontmatterField = (front: string, key: string): string | undefined => {
  for (const line of front.split(/\r?\n/)) {
    const index = line.indexOf(":")
    if (index > 0 && line.slice(0, index).trim() === key) {
      return line.slice(index + 1).trim()
    }
  }
  return undefined
}

export const parsePatternCard = (id: string, text: string): PatternCard => {
  const stripped = text.trim()
  if (!stripped.startsWith("---")) {
    return PatternCard.make({ id, matches: "", body: stripped })
  }
  const rest = stripped.slice(3)
  const end = /^---[ \t]*$/m.exec(rest)
  if (end === null) {
    return PatternCard.make({ id, matches: "", body: stripped })
  }
  return PatternCard.make({
    id,
    matches: frontmatterField(rest.slice(0, end.index), "match") ?? "",
    body: rest.slice(end.index + end[0].length).trim()
  })
}

/**
 * All `*.md` cards under `directory`, sorted by id (the filename stem). An
 * absent directory is an empty set — patterns are optional everywhere.
 */
export const loadPatternCards = Effect.fn("@llm4ts/flow/Patterns.load")(function* (
  workspace: WorkspaceShape,
  directory: string
): Effect.fn.Return<ReadonlyArray<PatternCard>, WorkspaceError> {
  const paths = yield* workspace.discover(`${directory}/*.md`).pipe(Effect.orElseSucceed(() => []))
  const cards: Array<PatternCard> = []
  for (const path of [...paths].sort()) {
    const file = path.split("/").at(-1) ?? path
    const text = yield* workspace.read(path).pipe(Effect.orElseSucceed(() => ""))
    cards.push(parsePatternCard(file.replace(/\.md$/, ""), text))
  }
  return cards.sort((left, right) => left.id.localeCompare(right.id))
})

/**
 * The cards whose `matches` regex hits anywhere in `source` — how extraction
 * decides which patterns a program embodies. A card with no regex never
 * matches; an invalid regex is skipped rather than failing the run.
 */
export const matchingPatternCards = (
  source: string,
  cards: ReadonlyArray<PatternCard>
): ReadonlyArray<PatternCard> =>
  cards.filter((card) => {
    if (card.matches.length === 0) {
      return false
    }
    try {
      return new RegExp(card.matches, "m").test(source)
    } catch {
      return false
    }
  })

/**
 * Every `PAT-…` id cited in a spec text, in order of first appearance — how
 * implementation finds the cards its current task's specs were tagged with.
 */
export const taggedPatternIds = (spec: string): ReadonlyArray<string> => [
  ...new Set(spec.match(/PAT-[A-Za-z0-9-]+/g) ?? [])
]
