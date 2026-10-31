/**
 * Memory notes (ADR 0047, decision 10 — the first slice of ADR 0007):
 * markdown files under `.llm4ts/memory/` the owner keeps, and run notes a
 * Memory Manager writes under `.llm4ts/memory/runs/`. Recall is code:
 * keyword overlap between a goal and each note, title and headings counting
 * double. Nothing here reads a file; the flow does.
 */
import { join } from "node:path"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"

export const memoryDir = (workDir: string): string => join(workDir, ".llm4ts", "memory")
export const runNotesDir = (workDir: string): string => join(memoryDir(workDir), "runs")

export class MemoryNote extends Schema.Class<MemoryNote>("MemoryNote")({
  /** The file's path under the memory folder without `.md`: `auth`, `runs/2026-10-30-auth`. */
  name: Schema.String,
  title: Schema.String,
  headings: Schema.Array(Schema.String),
  body: Schema.String
}) {}

/** A note from its markdown: the first `# ` line is the title (else the name), the `## ` lines its headings. */
export const parseNote = (name: string, markdown: string): MemoryNote => {
  let title: string | undefined
  const headings: Array<string> = []
  let fenced = false
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("```")) fenced = !fenced
    if (fenced) continue
    if (title === undefined && line.startsWith("# ")) title = line.slice(2).trim()
    else if (line.startsWith("## ")) headings.push(line.slice(3).trim())
  }
  return MemoryNote.make({ name, title: title ?? name, headings, body: markdown })
}

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "are",
  "our",
  "its",
  "how",
  "what",
  "can",
  "not",
  "but",
  "all",
  "any",
  "one",
  "two",
  "move",
  "make",
  "write",
  "does",
  "should",
  "would",
  "have",
  "has"
])

/** The words a text is matched on: lower case, three letters or more, no stop words. */
export const keywords = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !stopWords.has(word))
  )

const score = (goal: ReadonlySet<string>, note: MemoryNote): number => {
  const strong = keywords([note.title, ...note.headings].join(" "))
  const weak = keywords(note.body)
  let total = 0
  for (const word of goal) {
    if (strong.has(word)) total += 2
    else if (weak.has(word)) total += 1
  }
  return total
}

/** The notes that share words with the goal, best first, at most `limit`; a note that shares none is left out. */
export const recall = (
  goal: string,
  notes: ReadonlyArray<MemoryNote>,
  limit = 5
): ReadonlyArray<MemoryNote> => {
  const words = keywords(goal)
  return notes
    .map((note, index) => ({ note, index, score: score(words, note) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.note)
}

/** What the Memory Manager hands back at the end of a run. */
export class RunNote extends Schema.Class<RunNote>("RunNote")({
  decisions: Schema.Array(Schema.String),
  /** What the owner changed in the plan or answered. */
  preferences: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
  /** Paths and ids worth opening next time. */
  pointers: Schema.Array(Schema.String)
}) {}

export const runNoteJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    decisions: { type: "array", items: { type: "string" } },
    preferences: { type: "array", items: { type: "string" } },
    failed: { type: "array", items: { type: "string" } },
    pointers: { type: "array", items: { type: "string" } }
  },
  required: ["decisions", "preferences", "failed", "pointers"]
}

const bullets = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.length === 0 ? ["- none"] : items.map((item) => `- ${item.replace(/\s+/g, " ").trim()}`)

/** The run note as a file: `# Run: <id>`, the goal, the four sections. */
export const renderRunNote = (id: string, goal: string, note: RunNote): string =>
  [
    `# Run: ${id}`,
    "",
    `Goal: ${goal}`,
    "",
    "## Decisions",
    "",
    ...bullets(note.decisions),
    "",
    "## Preferences",
    "",
    ...bullets(note.preferences),
    "",
    "## Failed",
    "",
    ...bullets(note.failed),
    "",
    "## Pointers",
    "",
    ...bullets(note.pointers),
    ""
  ].join("\n")
