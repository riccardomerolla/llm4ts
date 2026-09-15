import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPack } from "@llm4ts/flow/Pack"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { DomainFeature } from "@llm4ts/flow/Domains"
import { PageSpec } from "@llm4ts/flow/PageSpec"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import {
  conversionInventory,
  featureInventory,
  featurePlan,
  migrationReport,
  parseWavePlan
} from "../flows/lib/convert.ts"

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

  it.effect("the j2ee pack's program-files slices target files per page precisely", () =>
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

  it("the feature plan is the port first, then each page with its tests in navigation order", () => {
    const spec = (page: string): PageSpec =>
      PageSpec.make({
        page,
        route: `/${page}`,
        title: page,
        complexity: "low",
        forms: [],
        apiCalls: [],
        dtos: [],
        navigation: { inbound: [], outbound: [], steps: [] },
        sessionState: [],
        openQuestions: []
      })
    const feature = DomainFeature.make({
      id: "beneficiary-maintenance",
      name: "Beneficiary maintenance",
      programs: ["beneficiaryEdit", "beneficiaryList"],
      context: ["header", "footer"],
      scenarios: [],
      evidence: "shared form target"
    })
    const plan = featurePlan(
      feature,
      ["beneficiaryList", "beneficiaryEdit"],
      new Map([
        ["beneficiaryList", spec("beneficiaryList")],
        ["beneficiaryEdit", spec("beneficiaryEdit")]
      ]),
      "contracts/beneficiary-maintenance.openapi.yaml"
    )
    assert.strictEqual(plan.epicId, "convert/beneficiary-maintenance")
    assert.deepStrictEqual(
      plan.tasks.map((task) => task.title),
      [
        "acl: beneficiary-maintenance service port and mock",
        "page: beneficiaryList component and tests",
        "page: beneficiaryEdit component and tests"
      ]
    )
    assert.include(plan.brief ?? "", "shared fragments header, footer")
    assert.include(plan.tasks[1]?.description ?? "", "tests/beneficiaryList.page.test.tsx")
  })

  it.effect(
    "the feature inventory follows the approved map by earliest wave and falls back to pages",
    () =>
      Effect.gen(function* () {
        const legacyDir = "/legacy"
        const domains = [
          "# Domain features",
          "",
          "inputs: abc",
          "",
          "## Feature: Wire transfer (wire-transfer)",
          "",
          "programs: transferStep1, transferStep2",
          "context: header",
          "evidence: one wizard",
          "",
          "- transferStep1 / Enter an amount",
          "",
          "## Feature: Beneficiary maintenance (beneficiary-maintenance)",
          "",
          "programs: beneficiaryList, beneficiaryEdit",
          "context:",
          "evidence: one servlet",
          "",
          "- beneficiaryList / List beneficiaries",
          "",
          "## Feature: Promo (promo)",
          "",
          "programs: promoQ3",
          "context:",
          "evidence: alone",
          "",
          "- promoQ3 / Show the campaign",
          "",
          "- [x] Approved",
          ""
        ].join("\n")
        const wavePlan = [
          "# Wave plan",
          "",
          "## Wave: wave-1",
          "- beneficiaryList",
          "- beneficiaryEdit",
          "",
          "## Wave: wave-2",
          "- transferStep1",
          "- transferStep2",
          "- promoQ3",
          "",
          "- [x] Approved",
          ""
        ].join("\n")
        const decisions = [
          "# Decisions",
          "",
          "## Programs",
          "",
          "- promoQ3: drop — expired campaign (smoke, 2026-09-15)",
          "",
          "- [x] Approved",
          ""
        ].join("\n")
        const memory = yield* makeMemoryPlainFileStore({
          "/legacy/docs/modernization/domains.md": domains,
          "/legacy/docs/modernization/wave-plan.md": wavePlan,
          "/legacy/docs/modernization/decisions.md": decisions
        })
        const legacy = yield* makeMemoryWorkspace()
        const workspace = yield* makeNodeWorkspace(flowsRoot)
        const pack = yield* loadPack(workspace, "packs/j2ee-nextjs-spa")

        const features = yield* featureInventory(memory.store, legacy, legacyDir, pack)
        assert.deepStrictEqual(
          features?.map((entry) => [entry.feature.id, entry.wave, entry.disposed]),
          [
            ["beneficiary-maintenance", "wave-1", false],
            ["promo", "wave-2", true],
            ["wire-transfer", "wave-2", false]
          ]
        )
        const pages = yield* conversionInventory(memory.store, legacy, legacyDir, pack)
        assert.deepStrictEqual(
          pages.map((entry) => [entry.page, entry.disposition]),
          [
            ["beneficiaryList", undefined],
            ["beneficiaryEdit", undefined],
            ["transferStep1", undefined],
            ["transferStep2", undefined],
            ["promoQ3", "drop"]
          ]
        )

        // An unapproved map is no map: the walk falls back to pages.
        yield* memory.store.writeAtomic(
          "/legacy/docs/modernization/domains.md",
          domains.replace("- [x] Approved", "- [ ] Approved")
        )
        assert.strictEqual(
          yield* featureInventory(memory.store, legacy, legacyDir, pack),
          undefined
        )
      })
  )
})
