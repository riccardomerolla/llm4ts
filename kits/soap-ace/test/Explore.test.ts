import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { makeMemoryWorkspace, type WorkspaceShape } from "@llm4ts/flow/Workspace"
import { type AuthProfile, decodeAuthProfile, type SecretSource } from "../flows/lib/soap/Auth.ts"
import type { WsdlCatalog } from "../flows/lib/soap/Catalog.ts"
import {
  type JudgedClass,
  type OperationsFile,
  parseOperationsFile
} from "../flows/lib/soap/Classification.ts"
import {
  ApiDesign,
  designPaths,
  parseDesignFile,
  renderDesignFile
} from "../flows/lib/soap/Design.ts"
import { serviceDirectory } from "../flows/lib/soap/Discover.ts"
import {
  designStep,
  exploreMarker,
  exploreService,
  leafNames,
  probeDecisions,
  probeOrder,
  renderExploreReport,
  writeEvidence
} from "../flows/lib/soap/Explore.ts"
import { samplePaths } from "../flows/lib/soap/Samples.ts"
import { makeDirectoryStubTransport } from "../flows/lib/soap/Stub.ts"
import type { SoapTransportShape } from "../flows/lib/soap/Transport.ts"
import { demoCatalog, demoResponses, fixtureRoot, replyingService } from "./support.ts"

const service = "DemoBankService"
// The stub's cercaConti answers with this IBAN instead of the fixture's
// (which is also the skeletons' example value): a live value to chain.
const fixtureIban = "IT60X0542811101000000123456"
const liveIban = "IT10X0306909606100000063412"
const reads = ["cercaConti", "dettaglioConto", "cercaMovimenti"]

const secrets: SecretSource = { environment: {}, readFile: () => Effect.die("unused") }

const operationsFile = (catalog: WsdlCatalog, status: "proposed" | "confirmed") =>
  parseOperationsFile(
    [
      `Status: ${status}`,
      ...catalog.operations.flatMap((operation) => [
        `## ${operation.name}`,
        `- class: ${reads.includes(operation.name) ? "read" : "mutating"}`
      ]),
      ""
    ].join("\n")
  )

const judgedRead = (names: ReadonlyArray<string>): Map<string, JudgedClass | undefined> =>
  new Map(names.map((name) => [name, { class: "read", confidence: 0.95, decision: "act" }]))

/** The stub backend, remembering every envelope it was sent. */
const recording = (catalog: WsdlCatalog) => {
  const sent: Array<string> = []
  const stub = makeDirectoryStubTransport(demoResponses, catalog)
  const transport: SoapTransportShape = {
    peerChain: stub.peerChain,
    send: (request) => {
      if (request.body !== undefined) sent.push(Redacted.value(request.body))
      return Effect.map(stub.send(request), (response) => ({
        ...response,
        body: new TextEncoder().encode(
          new TextDecoder().decode(response.body).replaceAll(fixtureIban, liveIban)
        )
      }))
    }
  }
  return { sent, transport }
}

const allText = (workspace: WorkspaceShape) =>
  Effect.gen(function* () {
    const files = yield* workspace.discover(".llm4ts/**")
    const texts = yield* Effect.forEach(files, (file) => workspace.read(file))
    return texts.join("\n")
  })

const setup = (status: "proposed" | "confirmed", environment = "test") =>
  Effect.gen(function* () {
    const catalog = yield* demoCatalog
    const workspace = yield* makeMemoryWorkspace()
    const operations = yield* operationsFile(catalog, status)
    const profile: AuthProfile = yield* decodeAuthProfile(
      JSON.stringify({ environment, endpoint: "https://soap.test.example/demo" })
    )
    return { catalog, workspace, operations, profile }
  })

const run = (
  context: {
    readonly catalog: WsdlCatalog
    readonly workspace: WorkspaceShape
    readonly operations: OperationsFile | undefined
    readonly profile: AuthProfile | undefined
  },
  transport: SoapTransportShape,
  options: {
    readonly judged?: ReadonlyMap<string, JudgedClass | undefined>
    readonly refresh?: boolean
  } = {}
) =>
  exploreService({
    workspace: context.workspace,
    catalog: context.catalog,
    service,
    profile: context.profile,
    operations: context.operations,
    judged: options.judged,
    secrets,
    transport,
    refresh: options.refresh ?? false,
    now: () => new Date("2026-09-28T10:00:00Z"),
    random: (size) => new Uint8Array(size).fill(3)
  })

describe("probe gate", () => {
  it.effect(
    "calls only reads, and before confirmation only on heuristic and judgment agreement in dev/test",
    () =>
      Effect.gen(function* () {
        const catalog = yield* demoCatalog
        const proposed = yield* operationsFile(catalog, "proposed")
        const confirmed = yield* operationsFile(catalog, "confirmed")
        const probed = (decisions: ReadonlyArray<{ operation: string; probe: boolean }>) =>
          decisions.filter((decision) => decision.probe).map((decision) => decision.operation)
        const allJudgedRead = judgedRead(catalog.operations.map((operation) => operation.name))

        // No auth.json: nothing, whatever else holds.
        assert.deepStrictEqual(
          probed(
            probeDecisions({
              catalog,
              operations: confirmed,
              environment: undefined,
              judged: allJudgedRead
            })
          ),
          []
        )
        // Confirmed: the file's reads, in any environment; mutating never.
        assert.deepStrictEqual(
          probed(
            probeDecisions({
              catalog,
              operations: confirmed,
              environment: "uat",
              judged: undefined
            })
          ),
          reads
        )
        // Unconfirmed without a judgment seat: nothing.
        const noSeat = probeDecisions({
          catalog,
          operations: proposed,
          environment: "test",
          judged: undefined
        })
        assert.deepStrictEqual(probed(noSeat), [])
        assert.include(noSeat[0]?.reason ?? "", "LLM4TS_JUDGMENT_PROVIDER")
        // Unconfirmed with agreement: the reads, even though the judgment said
        // read for the mutating ones too (the listed class wins).
        const agreed = probeDecisions({
          catalog,
          operations: proposed,
          environment: "test",
          judged: allJudgedRead
        })
        assert.deepStrictEqual(probed(agreed), reads)
        assert.strictEqual(agreed[0]?.basis, "provisional")
        // uat before confirmation: nothing.
        assert.deepStrictEqual(
          probed(
            probeDecisions({
              catalog,
              operations: proposed,
              environment: "uat",
              judged: allJudgedRead
            })
          ),
          []
        )
        // A hesitant judgment holds the operation back.
        const hesitant = new Map(allJudgedRead)
        hesitant.set("dettaglioConto", { class: "read", confidence: 0.6, decision: "caution" })
        assert.deepStrictEqual(
          probed(
            probeDecisions({ catalog, operations: proposed, environment: "dev", judged: hesitant })
          ),
          ["cercaConti", "cercaMovimenti"]
        )
      })
  )
})

describe("producer-first order", () => {
  it.effect("puts cercaConti before the operations that need its IBAN", () =>
    Effect.gen(function* () {
      const catalog = yield* demoCatalog
      assert.isTrue(
        leafNames(
          catalog,
          catalog.operations.find((o) => o.name === "dettaglioConto")?.input,
          true
        ).has("iban")
      )
      const plan = probeOrder(catalog, ["cercaMovimenti", "dettaglioConto", "cercaConti"])
      assert.strictEqual(plan.order[0], "cercaConti")
      assert.sameMembers([...plan.order], reads)
      assert.deepStrictEqual(plan.producers.get("dettaglioConto"), [
        { producer: "cercaConti", fields: ["iban"] }
      ])
      assert.deepInclude(plan.producers.get("cercaMovimenti") ?? [], {
        producer: "cercaConti",
        fields: ["iban"]
      })
    })
  )
})

describe("exploreService", () => {
  it.effect(
    "writes every request, probes the reads with chained live values, stores them masked",
    () =>
      Effect.gen(function* () {
        const context = yield* setup("confirmed")
        const { sent, transport } = recording(context.catalog)
        const result = yield* run(context, transport)

        assert.strictEqual(sent.length, 3)
        const byName = new Map(result.operations.map((report) => [report.operation, report]))
        for (const name of reads) assert.strictEqual(byName.get(name)?.outcome.kind, "called", name)
        for (const name of ["inserisciBonifico", "confermaBonifico", "revocaBonifico"]) {
          assert.strictEqual(byName.get(name)?.outcome.kind, "not-called", name)
          assert.strictEqual(byName.get(name)?.request, "written")
        }
        // The consumer was sent the IBAN the producer answered with ...
        const detail = sent[1] ?? ""
        assert.include(detail, "dettaglioConto")
        assert.include(detail, liveIban)
        assert.deepStrictEqual(byName.get("dettaglioConto")?.chained, [
          { producer: "cercaConti", fields: ["iban"] }
        ])
        // Credited to the operation that supplied the value, not every one that could.
        assert.deepStrictEqual(byName.get("cercaMovimenti")?.chained, [
          { producer: "cercaConti", fields: ["iban"] }
        ])
        // ... but nothing on disk carries it: request files and exchanges hold the pseudonym.
        const request = yield* context.workspace.read(
          samplePaths(service, "dettaglioConto", "happy-path").yaml
        )
        assert.isTrue(request.startsWith(exploreMarker))
        assert.include(request, "Chained at probe time: iban from cercaConti")
        assert.notInclude(yield* allText(context.workspace), liveIban)
      })
  )

  it.effect("continues on rerun, re-probes with --refresh, and leaves a user's file alone", () =>
    Effect.gen(function* () {
      const context = yield* setup("confirmed")
      const first = recording(context.catalog)
      yield* run(context, first.transport)

      const again = recording(context.catalog)
      const second = yield* run(context, again.transport)
      assert.strictEqual(again.sent.length, 0)
      assert.isTrue(
        second.operations
          .filter((r) => reads.includes(r.operation))
          .every((r) => r.outcome.kind === "recorded")
      )

      // The user takes over dettaglioConto's request by dropping the marker.
      const path = samplePaths(service, "dettaglioConto", "happy-path").yaml
      const owned = (yield* context.workspace.read(path)).split("\n").slice(1).join("\n")
      yield* context.workspace.write(path, owned)
      const refreshed = recording(context.catalog)
      const third = yield* run(context, refreshed.transport, { refresh: true })
      assert.strictEqual(refreshed.sent.length, 3)
      assert.strictEqual(
        third.operations.find((r) => r.operation === "dettaglioConto")?.request,
        "kept"
      )
      assert.strictEqual(yield* context.workspace.read(path), owned)
      assert.strictEqual(
        third.operations.find((r) => r.operation === "cercaMovimenti")?.request,
        "regenerated"
      )
    })
  )

  it.effect("calls nothing without auth.json or before confirmation without a judgment seat", () =>
    Effect.gen(function* () {
      const context = yield* setup("proposed")
      const none = recording(context.catalog)
      const withoutProfile = yield* run({ ...context, profile: undefined }, none.transport)
      const withoutSeat = yield* run(context, none.transport)
      assert.strictEqual(none.sent.length, 0)
      assert.isTrue(withoutProfile.operations.every((r) => r.outcome.kind === "not-called"))
      assert.isTrue(
        withoutSeat.operations.every((r) => r.request === "kept" || r.request === "written")
      )
      const report = renderExploreReport({
        service,
        catalog: context.catalog,
        profile: undefined,
        operations: context.operations,
        result: withoutProfile,
        design: { kind: "skipped", reason: "no exchanges yet: the design needs evidence" },
        evidence: { analyses: [], exchanges: 0 }
      })
      assert.include(report, '`{"environment": "test"}`')
      assert.include(report, "set `Status: confirmed`")
      assert.include(report, "not called: no auth.json")
    })
  )

  it.effect("probes provisionally in test when the judgment agrees", () =>
    Effect.gen(function* () {
      const context = yield* setup("proposed")
      const { sent, transport } = recording(context.catalog)
      const result = yield* run(context, transport, { judged: judgedRead(reads) })
      assert.strictEqual(sent.length, 3)
      assert.isTrue(
        result.operations
          .filter((r) => reads.includes(r.operation))
          .every((r) => r.decision.basis === "provisional" && r.outcome.kind === "called")
      )
    })
  )

  it.effect("reports a request that does not validate by path, never by value", () =>
    Effect.gen(function* () {
      const context = yield* setup("confirmed")
      const { transport } = recording(context.catalog)
      // A user's request for cercaConti that breaks its schema.
      yield* context.workspace.write(
        samplePaths(service, "cercaConti", "happy-path").yaml,
        'operation: cercaConti\npurpose: "mine"\nbody:\n  codiceFiscale: "SECRET-VALUE-XYZ"\n'
      )
      const result = yield* run(context, transport)
      const report = result.operations.find((r) => r.operation === "cercaConti")
      assert.strictEqual(report?.outcome.kind, "failed")
      assert.include(report?.outcome.detail ?? "", "codiceFiscale")
      assert.notInclude(report?.outcome.detail ?? "", "SECRET-VALUE-XYZ")
    })
  )
})

describe("design step", () => {
  const reference = parseDesignFile(
    readFileSync(join(fixtureRoot, "design", "api-design.md"), "utf8")
  )

  it.effect(
    "drafts from evidence, checks an existing design, and skips when off or without evidence",
    () =>
      Effect.gen(function* () {
        const context = yield* setup("confirmed")
        const style = "STYLE"
        const empty = yield* writeEvidence(context.workspace, context.catalog, service)
        const reply = replyingService(
          JSON.stringify(Schema.encodeSync(ApiDesign)((yield* reference).design))
        )
        const base = {
          workspace: context.workspace,
          catalog: context.catalog,
          service,
          operations: context.operations,
          style
        }
        assert.deepStrictEqual(yield* designStep({ ...base, evidence: empty, reasoning: reply }), {
          kind: "skipped",
          reason: "no exchanges yet: the design needs evidence"
        })

        yield* run(context, recording(context.catalog).transport)
        const evidence = yield* writeEvidence(context.workspace, context.catalog, service)
        assert.strictEqual(evidence.exchanges, 3)
        const off = yield* designStep({ ...base, evidence, reasoning: { off: "--no-design" } })
        assert.strictEqual(off.kind, "skipped")

        const drafted = yield* designStep({ ...base, evidence, reasoning: reply })
        assert.oneOf(drafted.kind, ["drafted", "revised"])
        const paths = designPaths(serviceDirectory(service))
        const file = yield* parseDesignFile(yield* context.workspace.read(paths.design))
        assert.isFalse(file.approved)

        // An approved design is kept and only checked.
        yield* context.workspace.write(paths.design, renderDesignFile(file.design, [], "approved"))
        const checked = yield* designStep({ ...base, evidence, reasoning: reply })
        assert.strictEqual(checked.kind, "checked")
        if (checked.kind === "checked") assert.isTrue(checked.approved)
      })
  )
})
