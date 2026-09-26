import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import {
  discoverService,
  loadCatalog,
  loadOperationsFile,
  servicePaths
} from "../flows/lib/soap/Discover.ts"
import { DocumentLoader, makeFileDocumentLoader } from "../flows/lib/soap/Wsdl.ts"

const wsdl = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "demo-bank-soap",
  "wsdl",
  "DemoBank.wsdl"
)

const discover = (workspace: Parameters<typeof discoverService>[0]["workspace"]) =>
  discoverService({ workspace, location: wsdl }).pipe(
    Effect.provideService(DocumentLoader, makeFileDocumentLoader())
  )

describe("Discover", () => {
  it.effect("persists catalog, summary, and proposed classes for the demo bank", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      const result = yield* discover(workspace)
      assert.strictEqual(result.service, "DemoBankService")
      const paths = servicePaths("DemoBankService")
      assert.deepStrictEqual(result.paths, paths)

      const reloaded = yield* loadCatalog(workspace, result.service)
      assert.deepStrictEqual(
        reloaded.operations.map((operation) => operation.name),
        result.catalog.operations.map((operation) => operation.name)
      )

      const summary = yield* workspace.read(paths.summary)
      assert.include(summary, "# SOAP catalog: DemoBankService")
      assert.include(summary, "### cercaMovimenti")
      assert.include(summary, "movimento: MovimentoType [0..*]")
      assert.include(summary, "**xsd-any**")

      assert.deepStrictEqual(
        result.proposals?.map((proposal) => [proposal.operation, proposal.proposed]),
        [
          ["cercaConti", "read"],
          ["dettaglioConto", "read"],
          ["cercaMovimenti", "read"],
          ["inserisciBonifico", "mutating"],
          ["confermaBonifico", "mutating"],
          ["revocaBonifico", "mutating"]
        ]
      )
      const operations = yield* loadOperationsFile(workspace, result.service)
      assert.strictEqual(operations?.confirmed, false)
    })
  )

  it.effect("keeps an existing operations file and reports drift", () =>
    Effect.gen(function* () {
      const paths = servicePaths("DemoBankService")
      const workspace = yield* makeMemoryWorkspace({
        initial: {
          [paths.operations]: [
            "# Operations",
            "Status: confirmed",
            "## cercaConti",
            "- class: read",
            "## vecchiaOperazione",
            "- class: read",
            ""
          ].join("\n")
        }
      })
      const result = yield* discover(workspace)
      assert.strictEqual(result.proposals, undefined)
      assert.strictEqual(result.existing?.confirmed, true)
      assert.deepStrictEqual(result.drift.unknown, ["vecchiaOperazione"])
      assert.include(result.drift.missing, "inserisciBonifico")
      const kept = yield* workspace.read(paths.operations)
      assert.include(kept, "vecchiaOperazione")
    })
  )
})
