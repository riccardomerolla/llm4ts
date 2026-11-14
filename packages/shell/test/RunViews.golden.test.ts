import { readFileSync, writeFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeProfileProgram } from "../src/Profile.ts"
import { makeWatchProgram } from "../src/Watch.ts"

/**
 * What `llm4ts profile` and `llm4ts watch` (no terminal) print for the
 * runner's recorded runs, pinned byte for byte. `UPDATE_GOLDENS=1` rewrites
 * the files under `fixtures/run-views/`.
 */

const traces = ["agent-tree", "agent-tree.clones", "run-views"] as const

const runnerFixture = (name: string): string =>
  readFileSync(new URL(`../../runner/test/fixtures/${name}`, import.meta.url), "utf8")

const golden = (name: string, text: string): void => {
  const url = new URL(`./fixtures/run-views/${name}.txt`, import.meta.url)
  if (process.env.UPDATE_GOLDENS === "1") {
    writeFileSync(url, text)
  }
  assert.strictEqual(text, readFileSync(url, "utf8"))
}

const tracePath = "/repo/.llm4ts/trace-1.jsonl"

const sourcesOf = (trace: string) =>
  Effect.map(
    makeMemoryPlainFileStore({ [tracePath]: runnerFixture(`${trace}.trace.jsonl`) }),
    (memory) => ({
      files: memory.store,
      listTraces: () => [tracePath],
      listEpics: () => []
    })
  )

describe("offline run views over recorded traces", () => {
  for (const trace of traces) {
    it.effect(`profile: ${trace}`, () =>
      Effect.gen(function* () {
        const sources = yield* sourcesOf(trace)
        golden(`${trace}.profile`, `${yield* makeProfileProgram({ repo: "/repo" }, sources)}\n`)
        golden(
          `${trace}.profile-json`,
          `${yield* makeProfileProgram({ repo: "/repo", json: true }, sources)}\n`
        )
      })
    )

    it.effect(`watch, last frame: ${trace}`, () =>
      Effect.gen(function* () {
        const sources = yield* sourcesOf(trace)
        const written = yield* Ref.make("")
        yield* makeWatchProgram(
          { repo: "/repo" },
          {
            ...sources,
            output: {
              write: (text) => Ref.update(written, (all) => all + text),
              columns: () => 100,
              rows: () => 40,
              interactive: false,
              colour: false
            },
            keys: Stream.empty,
            transcripts: { read: () => Effect.succeed(undefined), list: () => [] }
          }
        )
        golden(`${trace}.watch`, yield* Ref.get(written))
      })
    )
  }
})
