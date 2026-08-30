import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPack } from "@llm4ts/flow/Pack"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { migrationReport, parseWavePlan } from "../lib/convert.ts"

const flowsRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("convert lib", () => {
  it("parses the survey wave plan into ordered pages", () => {
    const waves = parseWavePlan(
      [
        "# Wave plan",
        "",
        "## Wave: wave-1",
        "- accountOverview",
        "- beneficiaryList",
        "",
        "## Wave: wave-2",
        "- transferStep1",
        "",
        "## Triage",
        "- oldTransfer: retire"
      ].join("\n")
    )

    assert.deepStrictEqual(
      waves.map((entry) => entry.wave),
      ["wave-1", "wave-2"]
    )
    assert.deepStrictEqual(waves[0]?.pages, ["accountOverview", "beneficiaryList"])
    assert.deepStrictEqual(waves[1]?.pages, ["transferStep1"])
  })

  it("labels every migration-report figure as estimated and projects the remainder", () => {
    const report = migrationReport(
      [
        { page: "accountOverview", outcome: "done", estimatedTokens: 1000, estimatedCostUsd: 2 },
        { page: "beneficiaryList", outcome: "done", estimatedTokens: 3000, estimatedCostUsd: 4 },
        { page: "oldTransfer", outcome: "skipped", detail: "no extracted spec" }
      ],
      ["transferStep1", "settings"]
    )

    assert.include(report, "ESTIMATE")
    assert.include(report, "Pages converted: 2")
    assert.include(report, "Pages remaining: 2")
    assert.include(report, "~2000 tokens/page × 2 pages")
    assert.include(report, "~$3.00/page × 2 pages")
    assert.include(report, "| oldTransfer | skipped")
  })

  it.effect("the j2ee pack's programFiles slices target files per page precisely", () =>
    Effect.gen(function* () {
      const workspace = yield* makeNodeWorkspace(flowsRoot)
      const pack = yield* loadPack(workspace, "packs/j2ee-nextjs-spa")
      const files = pack.filesFor("accountOverview")

      assert.isTrue(files.test("src/app/accountOverview/page.tsx"))
      assert.isTrue(files.test("src/services/accountOverview/port.ts"))
      assert.isTrue(files.test("contracts/accountOverview.openapi.yaml"))
      assert.isTrue(files.test("tests/accountOverview.page.test.tsx"))
      assert.isFalse(files.test("src/app/cards/page.tsx"))
      assert.isFalse(files.test("src/services/registry.ts"))
      assert.isFalse(files.test("contracts/beneficiaryList.openapi.yaml"))
    })
  )

  it.effect("the j2ee coverage rules fire on representative legacy source", () =>
    Effect.gen(function* () {
      const workspace = yield* makeNodeWorkspace(flowsRoot)
      const pack = yield* loadPack(workspace, "packs/j2ee-nextjs-spa")
      const rule = (name: string) => pack.coverage.find((candidate) => candidate.name === name)

      assert.match(
        "<url-pattern>/accountOverview</url-pattern>",
        new RegExp(rule("servlet-url")?.unit ?? "$^")
      )
      assert.match(
        '<form action="/app/transfer" method="post">',
        new RegExp(rule("jsp-form")?.unit ?? "$^")
      )
      assert.match("$.ajax({ url: '/api/balances',", new RegExp(rule("jsp-ajax")?.unit ?? "$^"))
    })
  )
})
