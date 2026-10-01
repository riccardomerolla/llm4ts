import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TranscriptEntry, type TranscriptSink } from "@llm4ts/flow/Transcript"

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
