import { assert, describe, it } from "@effect/vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { parseFlowArgs, readFlowPrompt, resolveFlowRepo } from "@llm4ts/runner/FlowArgs"

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-args-"))),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
)

describe("flow CLI arguments", () => {
  it("accepts the package-manager argument separator", () => {
    assert.deepStrictEqual(parseFlowArgs(["--", "do it", "--repo", "target"]), {
      ok: true,
      value: {
        promptText: "do it",
        repo: "target"
      }
    })
  })

  it("parses prompt sources, repository aliases, and rejects unknown flags", () => {
    assert.deepStrictEqual(parseFlowArgs([" do it "]), {
      ok: true,
      value: { promptText: "do it" }
    })
    assert.deepStrictEqual(parseFlowArgs(["@brief.md", "-C", "repo", "ignored"]), {
      ok: true,
      value: { promptFile: "brief.md", repo: "repo", promptText: "ignored" }
    })
    assert.isFalse(parseFlowArgs(["--unknown"]).ok)
    assert.isFalse(parseFlowArgs(["--repo"]).ok)
  })

  it("recognizes help and version flags", () => {
    assert.deepStrictEqual(parseFlowArgs(["--help"]), {
      ok: true,
      value: { help: true }
    })
    assert.deepStrictEqual(parseFlowArgs(["-h"]), {
      ok: true,
      value: { help: true }
    })
    assert.deepStrictEqual(parseFlowArgs(["--version"]), {
      ok: true,
      value: { version: true }
    })
  })

  it.effect("gives prompt files precedence and validates repositories", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryDirectory
        yield* Effect.promise(() => writeFile(join(root, "prompt.md"), "verbatim\nprompt\n"))
        const prompt = yield* readFlowPrompt({
          promptText: "ignored",
          promptFile: join(root, "prompt.md")
        })
        const repo = yield* resolveFlowRepo({}, root)
        const missing = yield* Effect.flip(resolveFlowRepo({ repo: "missing" }, root))

        assert.strictEqual(prompt, "verbatim\nprompt\n")
        assert.strictEqual(repo, root)
        assert.strictEqual(missing._tag, "ScriptUsage")
      })
    )
  )
})
