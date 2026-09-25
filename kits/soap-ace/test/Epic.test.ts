import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadPack } from "@llm4ts/flow/Pack"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { makeStoryPlanStore, storyPlanViolations, topologicalWaves } from "@llm4ts/flow/StoryPlan"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { parseDesignFile } from "../flows/lib/soap/Design.ts"
import {
  apiNameFor,
  epicIdFor,
  epicSentence,
  schemaFolder,
  seedFiles,
  storyPlanFor,
  writeSeed
} from "../flows/lib/soap/Epic.ts"
import { readExchanges } from "../flows/lib/soap/Samples.ts"
import { fixtureRoot, recordedEvidence } from "./support.ts"

const referenceDesign = parseDesignFile(
  readFileSync(join(fixtureRoot, "design", "api-design.md"), "utf8")
)
const service = "DemoBankService"

describe("ace12-rest pack", () => {
  it.effect("loads with its gates, judge dimensions, and scaffold", () =>
    Effect.gen(function* () {
      const kitsRoot = join(fixtureRoot, "..", "..", "..")
      const workspace = yield* makeNodeWorkspace(kitsRoot)
      const pack = yield* loadPack(workspace, "soap-ace/packs/ace12-rest")
      assert.strictEqual(pack.name, "ace12-rest")
      assert.deepStrictEqual(pack.gates["build"], ["bash", "scripts/ace-gates.sh", "build"])
      assert.deepStrictEqual(pack.gates["test"], ["bash", "scripts/ace-gates.sh", "test"])
      assert.includeMembers(
        pack.judgeDimensions.map((dimension) => dimension.name),
        ["contract", "mapping", "errors"]
      )
    })
  )
})

describe("ACE epic", () => {
  it("names the API project and broker schemas", () => {
    assert.strictEqual(apiNameFor("DemoBankService"), "DemoBankApi")
    assert.strictEqual(apiNameFor("conti-ws"), "ContiwsApi")
    assert.strictEqual(schemaFolder("credit-transfers"), "creditTransfers")
  })

  it.effect(
    "derives a valid story plan in three waves, with evidence in the resource stories",
    () =>
      Effect.gen(function* () {
        const { analyses } = yield* recordedEvidence
        const { design } = yield* referenceDesign
        const plan = storyPlanFor({ design, service, api: "DemoBankApi", analyses })
        assert.deepStrictEqual(storyPlanViolations(plan), [])
        assert.deepStrictEqual(topologicalWaves(plan), [
          ["api-skeleton", "policies", "shared-lib", "backend-stub"],
          ["resource-accounts", "resource-credit-transfers"],
          ["contract-check"]
        ])
        const accounts = plan.story("resource-accounts")
        assert.deepStrictEqual(accounts?.owned, [
          "DemoBankApi/resources/accounts",
          "DemoBankApi_Test/src/resources/accounts"
        ])
        assert.include(
          accounts?.description ?? "",
          "GET /accounts/{iban}/movements (listMovements) from cercaMovimenti"
        )
        assert.include(
          accounts?.description ?? "",
          "values outside the declared enumeration: SOSPESO"
        )
        assert.include(
          plan.story("resource-credit-transfers")?.description ?? "",
          "422 invalid-otp ← KO17"
        )
        assert.include(
          plan.story("api-skeleton")?.description ?? "",
          "resources.creditTransfers.revokeCreditTransfer: POST /v1/credit-transfers/{transferId}/revocation"
        )
      })
  )

  it.effect("uses the epic id epic-stories derives from the same sentence", () =>
    Effect.gen(function* () {
      const { design } = yield* referenceDesign
      const sentence = epicSentence(design, "DemoBankApi", service)
      // Pinned from flows/lib/epic-stories.ts epicIdFor on this sentence: the plan
      // is only found if both sides agree.
      assert.strictEqual(epicIdFor(sentence), "implement-the-demobankapi-rest-890802")
      const plan = storyPlanFor({ design, service, api: "DemoBankApi", analyses: [] })
      assert.strictEqual(plan.epicId, "implement-the-demobankapi-rest-890802")
      const files = yield* makeMemoryPlainFileStore()
      const store = makeStoryPlanStore(files.store)
      yield* store.save("/ace/.llm4ts/epics/x/plan.md", plan)
      const back = yield* store.load("/ace/.llm4ts/epics/x/plan.md")
      assert.strictEqual(back?.stories.length, 7)
    })
  )

  it.effect("seeds contracts, stubs, and house rules; keeps what the team owns", () =>
    Effect.gen(function* () {
      const { workspace, catalog } = yield* recordedEvidence
      const { design } = yield* referenceDesign
      const files = seedFiles({
        design,
        catalog,
        service,
        api: "DemoBankApi",
        scaffold: [
          { path: "CONTRIBUTING.md", contents: "# Contributing to __API__ (__SERVICE__)" },
          { path: "scripts/ace-gates.sh", contents: 'API="__API__"' }
        ],
        patterns: [{ path: "PAT-ACE-001.md", contents: "card" }],
        soapDocuments: [{ path: "DemoBank.wsdl", contents: "<definitions/>" }],
        analyses: [{ operation: "cercaConti", markdown: "# Analysis" }],
        exchanges: yield* readExchanges(workspace, service)
      })
      const byPath = new Map(files.map((file) => [file.path, file]))
      assert.strictEqual(
        byPath.get("CONTRIBUTING.md")?.contents,
        "# Contributing to DemoBankApi (DemoBankService)"
      )
      assert.match(byPath.get("contracts/openapi-ace.yaml")?.contents ?? "", /^openapi: 3\.0\.3\n/)
      assert.match(byPath.get("contracts/openapi.yaml")?.contents ?? "", /^openapi: 3\.1\.0\n/)
      assert.isDefined(byPath.get("contracts/mapping.json"))
      assert.isDefined(byPath.get("contracts/soap/DemoBank.wsdl"))
      assert.include(
        byPath.get("test-data/cercaConti/sample.response.xml")?.contents ?? "",
        "cercaContiResponse"
      )
      assert.isDefined(byPath.get("test-data/cercaConti/sample.request.xml"))

      const target = yield* makeMemoryWorkspace({
        initial: { "CONTRIBUTING.md": "ours", "contracts/openapi.yaml": "stale" }
      })
      const seeded = yield* writeSeed(target, files)
      assert.strictEqual(seeded.kept, 1)
      assert.strictEqual(yield* target.read("CONTRIBUTING.md"), "ours")
      assert.notStrictEqual(yield* target.read("contracts/openapi.yaml"), "stale")
    })
  )
})
