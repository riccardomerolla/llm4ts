import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { WallBreached, checkWall, wallBreachMessage } from "@llm4ts/flow/Wall"

const cobolSources = ".*\\.(cbl|CBL|cpy|CPY|jcl|JCL)"

describe("Wall", () => {
  it.effect("reports a clean workspace when no legacy source is present", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace({
        initial: {
          "src/main/java/Transfer.java": "class Transfer {}",
          "docs/specs/ACCTXFR.md": "# ACCTXFR"
        }
      })
      const result = yield* checkWall(workspace, cobolSources)
      assert.strictEqual(result._tag, "Clean")
    })
  )

  it.effect("reports every legacy file as a breach", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace({
        initial: {
          "src/main/java/Transfer.java": "class Transfer {}",
          "legacy/ACCTXFR.cbl": "       IDENTIFICATION DIVISION.",
          "legacy/RUNJOB.JCL": "//STEP1 EXEC PGM=ACCTXFR"
        }
      })
      const result = yield* checkWall(workspace, cobolSources)
      assert.strictEqual(result._tag, "Breached")
      if (result._tag === "Breached") {
        assert.deepStrictEqual([...result.paths], ["legacy/ACCTXFR.cbl", "legacy/RUNJOB.JCL"])
      }
    })
  )

  it.effect("exempts repository internals under .git", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace({
        initial: {
          ".git/objects/pack/old.cbl": "a packed legacy blob",
          "src/main/java/Transfer.java": "class Transfer {}"
        }
      })
      const result = yield* checkWall(workspace, cobolSources)
      assert.strictEqual(result._tag, "Clean")
    })
  )

  it("caps the breach message at ten paths and names the consequence", () => {
    const paths = Array.from({ length: 12 }, (_, index) => `legacy/PROG${index}.cbl`)
    const message = wallBreachMessage(new WallBreached({ paths }), "Remove the files and rerun.")
    assert.include(message, "legacy/PROG0.cbl")
    assert.include(message, "(+2 more)")
    assert.notInclude(message, "legacy/PROG11.cbl")
    assert.include(message, "Remove the files and rerun.")
  })
})
