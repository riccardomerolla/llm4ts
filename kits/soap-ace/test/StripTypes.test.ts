import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as nodeModule from "node:module"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"

// Kit flows run as plain `.ts` under Node's strip-only type support, which
// refuses TypeScript that needs code generation (parameter properties,
// enums, namespaces). Every flow and library file must strip cleanly.

const flowsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "flows")

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : []
  )

describe("kit sources", () => {
  it.effect("strip under Node's type-stripping mode", () =>
    Effect.gen(function* () {
      const files = sources(flowsRoot)
      assert.isAbove(files.length, 0)
      for (const file of files) {
        const text = yield* Effect.promise(() => readFile(file, "utf8"))
        const stripped = yield* Effect.try({
          try: () => nodeModule.stripTypeScriptTypes(text, { mode: "strip" }),
          catch: (cause) => `${file}: ${cause instanceof Error ? cause.message : String(cause)}`
        }).pipe(Effect.flip, Effect.option)
        assert.isTrue(stripped._tag === "None", stripped._tag === "Some" ? stripped.value : "")
      }
    })
  )
})
