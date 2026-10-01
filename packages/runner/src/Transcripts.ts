import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { summariseToolArgs } from "@llm4ts/flow/Activity"
import { TranscriptEntry, type TranscriptSink } from "@llm4ts/flow/Transcript"
import { duration } from "./Profile.ts"

/**
 * Transcripts on disk (`llm4ts run --transcript`): one JSON line per entry,
 * one file per story (`<lane>.jsonl`) and `run.jsonl` for the rest, under
 * `.llm4ts/transcripts/<run-id>/`. They hold the customer's code and the
 * model's replies, so only their owner can read them, and a write that fails
 * never fails the run.
 */

/** `LLM4TS_TRANSCRIPT=on` (what `--transcript` sets); also `1`, `true`, `yes`. */
export const transcriptsWanted = (
  environment: Readonly<Record<string, string | undefined>>
): boolean => /^(on|1|true|yes)$/iu.test(environment.LLM4TS_TRANSCRIPT?.trim() ?? "")

export const transcriptFileOf = (lane: string | undefined): string =>
  `${(lane ?? "run").replace(/[^A-Za-z0-9._-]/gu, "_")}.jsonl`

const encode = Schema.encodeSync(Schema.fromJsonString(TranscriptEntry))

export const nodeTranscriptSink = (directory: string): TranscriptSink => {
  let made = false
  return {
    write: (lane, entry) =>
      Effect.sync(() => {
        try {
          if (!made) {
            mkdirSync(directory, { recursive: true, mode: 0o700 })
            made = true
          }
          appendFileSync(join(directory, transcriptFileOf(lane)), `${encode(entry)}\n`, {
            mode: 0o600
          })
        } catch {
          // A transcript is a window on the run, never a reason to stop it.
        }
      })
  }
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface TranscriptView {
  readonly width: number
  /** Only calls made in this role (coder, reviewer, judge, …). */
  readonly role?: string
  /** Only calls served by this executor. */
  readonly executor?: string
  /** Keep the last lines only. */
  readonly last?: number
}

const clockOf = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  return [Math.floor(seconds / 3_600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

const cut = (line: string, width: number): string =>
  [...line].length <= width ? line : `${[...line].slice(0, Math.max(0, width - 1)).join("")}…`

/** `text` as lines of at most `width`, the first after `prefix`, the rest indented. */
const wrapped = (prefix: string, text: string, width: number, limit = Infinity): Array<string> => {
  const room = Math.max(10, width - prefix.length)
  const lines: Array<string> = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(/\s+/u).filter((part) => part.length > 0)) {
      if (line.length > 0 && line.length + 1 + word.length > room) {
        lines.push(line)
        line = ""
      }
      line = line.length === 0 ? cut(word, room) : `${line} ${word}`
    }
    lines.push(line)
  }
  const kept = lines.filter((line, index) => line.length > 0 || index < lines.length - 1)
  const shown = kept.slice(0, limit)
  const more = kept.length - shown.length
  return [
    ...shown.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`),
    ...(more > 0 ? [`${" ".repeat(prefix.length)}… (${more} more lines)`] : [])
  ]
}

const inputLines = 12

/**
 * A transcript as the tail pane and `watch --tail` show it: each call under
 * a header (when, who), its input, the reply as one text, every tool with
 * the gist of its result, and how long the call took.
 */
export const renderTranscript = (
  entries: ReadonlyArray<TranscriptEntry>,
  view: TranscriptView
): ReadonlyArray<string> => {
  const { width } = view
  const start = entries[0]?.at ?? 0
  const wanted = new Set(
    entries.flatMap((entry) =>
      entry._tag === "Call" &&
      (view.role === undefined || entry.role === view.role) &&
      (view.executor === undefined || entry.executor === view.executor)
        ? [entry.call]
        : []
    )
  )
  const lines: Array<string> = []
  let reply: { call: string; text: string } | undefined
  const flushReply = () => {
    if (reply !== undefined && reply.text.trim().length > 0) {
      lines.push(...wrapped("◀ ", reply.text.trim(), width))
    }
    reply = undefined
  }
  for (const entry of entries) {
    if (!wanted.has(entry.call)) {
      continue
    }
    if (entry._tag !== "Reply") {
      flushReply()
    }
    switch (entry._tag) {
      case "Call": {
        const title = `── ${clockOf(entry.at - start)} ${entry.role}${
          entry.executor === undefined ? "" : ` · ${entry.executor}`
        } `
        lines.push(cut(title.padEnd(width, "─"), width))
        if (entry.system !== undefined) {
          const [first = "", ...more] = entry.system.split("\n")
          lines.push(
            cut(
              `▶ system: ${first}${more.length === 0 ? "" : ` … (${more.length + 1} lines)`}`,
              width
            )
          )
        }
        if (entry.earlier !== undefined && entry.earlier > 0) {
          lines.push(`▶ (${entry.earlier} earlier messages)`)
        }
        lines.push(...wrapped("▶ ", entry.input, width, inputLines))
        break
      }
      case "Reply":
        reply =
          reply?.call === entry.call
            ? { call: entry.call, text: reply.text + entry.text }
            : { call: entry.call, text: entry.text }
        break
      case "Tool":
        lines.push(cut(`⚙ ${entry.tool} ${summariseToolArgs(entry.args)}`.trimEnd(), width))
        break
      case "ToolResult": {
        const outputLines = entry.output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        const gist = outputLines.slice(0, 3).join(" · ")
        lines.push(
          cut(
            `  ↳ ${entry.failed === true ? "failed" : "ok"}${gist.length === 0 ? "" : `: ${gist}`}${
              outputLines.length > 3 ? " …" : ""
            }`,
            width
          )
        )
        break
      }
      case "End":
        lines.push(`  (${duration(entry.ms)}${entry.failed === true ? ", failed" : ""})`)
        break
    }
  }
  flushReply()
  return view.last === undefined ? lines : lines.slice(-view.last)
}

/** How a host reaches a run's transcript files. */
export interface TranscriptFiles {
  readonly read: (path: string) => Effect.Effect<string | undefined>
  /** File names in a directory; none when it does not exist. */
  readonly list: (directory: string) => ReadonlyArray<string>
}

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptEntry))

/** A transcript file's entries; a torn last line (a write in progress) is skipped. */
export const parseTranscript = (text: string): ReadonlyArray<TranscriptEntry> =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const decoded = decodeEntry(line)
      return decoded._tag === "Some" ? [decoded.value] : []
    })

export type TailTarget = { readonly lane: string } | { readonly executor: string }

/**
 * The entries a tail shows: a story's file, or every file for an executor
 * (in time order). `undefined` when the run kept no transcript at all.
 */
export const loadTranscript = (
  files: TranscriptFiles,
  directory: string,
  target: TailTarget
): Effect.Effect<ReadonlyArray<TranscriptEntry> | undefined> =>
  Effect.gen(function* () {
    const names = files.list(directory).filter((name) => name.endsWith(".jsonl"))
    if (names.length === 0) {
      return undefined
    }
    const wanted = "lane" in target ? [transcriptFileOf(target.lane)] : names
    const all: Array<TranscriptEntry> = []
    for (const name of wanted) {
      const text = yield* files.read(join(directory, name))
      all.push(...parseTranscript(text ?? ""))
    }
    return "lane" in target ? all : [...all].sort((left, right) => left.at - right.at)
  })

/** The last `rows` lines of a tail, or `undefined` when the run has no transcript. */
export const tailLinesOf = (
  entries: ReadonlyArray<TranscriptEntry> | undefined,
  target: TailTarget,
  role: string | undefined,
  width: number,
  rows: number
): ReadonlyArray<string> | undefined =>
  entries === undefined
    ? undefined
    : renderTranscript(entries, {
        width,
        last: rows,
        ...(role === undefined ? {} : { role }),
        ...("executor" in target ? { executor: target.executor } : {})
      })

export const nodeTranscriptFiles: TranscriptFiles = {
  read: (path) =>
    Effect.sync(() => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return undefined
      }
    }),
  list: (directory) => {
    try {
      return readdirSync(directory)
    } catch {
      return []
    }
  }
}
