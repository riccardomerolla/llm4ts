import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import {
  approveMarkdown,
  loadDecisions,
  loadDomains,
  saveDecisions,
  scanPack,
  signer
} from "@llm4ts/shell/Refine"
import { Decisions } from "@llm4ts/flow/Decisions"

const pack = (): string => {
  const root = mkdtempSync(join(tmpdir(), "llm4ts-refine-"))
  const modDir = join(root, "docs/modernization")
  mkdirSync(join(modDir, "specs"), { recursive: true })
  mkdirSync(join(modDir, "features"), { recursive: true })
  writeFileSync(join(modDir, "specs", "README.md"), "# pack\n")
  writeFileSync(join(modDir, "specs", "accountOverview.md"), "# accountOverview\n")
  writeFileSync(join(modDir, "specs", "login.md"), "# login\n")
  writeFileSync(
    join(modDir, "features", "accountoverview.feature"),
    "Feature: overview\n\n  Scenario: List accounts\n    Given x\n\n  Scenario: Export CSV\n    Given y\n"
  )
  return modDir
}

describe("llm4ts refine — the file is the state", () => {
  it.effect("scans the pack's programs and scenario titles", () =>
    Effect.gen(function* () {
      const inventory = yield* scanPack(pack())
      assert.deepStrictEqual(inventory.programs, ["accountOverview", "login"])
      assert.deepStrictEqual(inventory.scenarios.get("accountOverview"), [
        "List accounts",
        "Export CSV"
      ])
      assert.deepStrictEqual(inventory.scenarios.get("login"), [])
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it.effect("an absent overlay loads empty, a saved one round-trips", () =>
    Effect.gen(function* () {
      const modDir = pack()
      assert.strictEqual((yield* loadDecisions(modDir)).isEmpty, true)
      assert.strictEqual(yield* loadDomains(modDir), undefined)
      yield* saveDecisions(
        modDir,
        Decisions.make({
          programs: [{ program: "login", disposition: "drop", reason: "target owns it" }],
          scenarios: [],
          marks: [{ program: "accountOverview", scenario: "Export CSV", note: "still used?" }],
          deepen: [],
          openPoints: [],
          approved: false
        })
      )
      const loaded = yield* loadDecisions(modDir)
      assert.deepStrictEqual(
        loaded.programs.map((entry) => [entry.program, entry.disposition]),
        [["login", "drop"]]
      )
      assert.deepStrictEqual(
        loaded.marks.map((mark) => [mark.program, mark.scenario, mark.note]),
        [["accountOverview", "Export CSV", "still used?"]]
      )
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )

  it("flips the draft marker and leaves an approved document alone", () => {
    assert.strictEqual(approveMarkdown("# x\n\n- [ ] Approved\n"), "# x\n\n- [x] Approved\n")
    assert.strictEqual(approveMarkdown("# x\n\n- [x] Approved\n"), "# x\n\n- [x] Approved\n")
    assert.strictEqual(approveMarkdown("# no marker\n"), "# no marker\n")
  })

  it("signs with LLM4TS_APPROVER when set", () => {
    assert.strictEqual(signer({ LLM4TS_APPROVER: "riccardo" }), "riccardo")
    assert.isAbove(signer({}).length, 0)
  })
})
