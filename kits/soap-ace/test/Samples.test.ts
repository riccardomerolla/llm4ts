import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { makeMemoryWorkspace, type WorkspaceShape } from "@llm4ts/flow/Workspace"
import { decodeAuthProfile, type SecretSource } from "../flows/lib/soap/Auth.ts"
import { callOperation } from "../flows/lib/soap/Call.ts"
import type { WsdlCatalog } from "../flows/lib/soap/Catalog.ts"
import { parseOperationsFile } from "../flows/lib/soap/Classification.ts"
import { servicePaths } from "../flows/lib/soap/Discover.ts"
import { isValidIban } from "../flows/lib/soap/Masking.ts"
import {
  listRequests,
  readExchanges,
  renderRequestFile,
  samplePaths,
  seedsForService,
  seedsFromExchanges
} from "../flows/lib/soap/Samples.ts"
import { proposeScenarios } from "../flows/lib/soap/Scenarios.ts"
import { importSoapUiProject } from "../flows/lib/soap/SoapUiImport.ts"
import { makeDirectoryStubTransport } from "../flows/lib/soap/Stub.ts"
import { makeFakeSoapTransport } from "../flows/lib/soap/Transport.ts"
import { demoCatalog, demoResponses, demoSoapUi, fixedKey, replyingService } from "./support.ts"

const service = "DemoBankService"
const cf = "RSSMRA85T10A562S"
const iban = "IT60X0542811101000000123456"

const secrets: SecretSource = {
  environment: { SVC_PASS: "basic-secret", WS_PASS: "ws-secret" },
  readFile: () => Effect.die("no files")
}

const operationsFile = parseOperationsFile(
  [
    "Status: confirmed",
    "## cercaConti",
    "- class: read",
    "## dettaglioConto",
    "- class: read",
    "## cercaMovimenti",
    "- class: read",
    "## revocaBonifico",
    "- class: mutating",
    ""
  ].join("\n")
)

const setup = (environment = "dev") =>
  Effect.gen(function* () {
    const catalog = yield* demoCatalog
    const workspace = yield* makeMemoryWorkspace()
    const profile = yield* decodeAuthProfile(
      JSON.stringify({
        environment,
        call: { auth: { scheme: "basic", user: "svc", password: "env:SVC_PASS" } },
        wsSecurity: { user: "ws-user", password: "env:WS_PASS", passwordType: "digest" }
      })
    )
    const fake = yield* makeFakeSoapTransport((request) =>
      makeDirectoryStubTransport(demoResponses, catalog).send(request)
    )
    const operations = yield* operationsFile
    return { catalog, workspace, profile, fake, operations }
  })

const writeRequest = (
  workspace: WorkspaceShape,
  catalog: WsdlCatalog,
  operation: string,
  name: string,
  body?: Parameters<typeof renderRequestFile>[0]["body"]
) =>
  workspace.write(
    samplePaths(service, operation, name).yaml,
    renderRequestFile({
      catalog,
      operation,
      purpose: `${name} test`,
      ...(body === undefined ? {} : { body })
    })
  )

const noMutation = () => Effect.succeed(false)

describe("callOperation", () => {
  it.effect("sends an authenticated, WS-Security-signed call and records a masked exchange", () =>
    Effect.gen(function* () {
      const { catalog, workspace, profile, fake, operations } = yield* setup()
      yield* writeRequest(workspace, catalog, "cercaConti", "happy-path", { codiceFiscale: cf })
      const result = yield* callOperation({
        workspace,
        catalog,
        service,
        operation: "cercaConti",
        name: "happy-path",
        profile,
        operations,
        secrets,
        transport: fake.transport,
        allowMutating: undefined,
        confirm: noMutation,
        random: (size) => new Uint8Array(size).fill(1),
        now: () => new Date("2026-09-25T10:00:00Z")
      })

      const [sent] = yield* fake.requests
      const wire = Redacted.value(sent?.body ?? Redacted.make(""))
      assert.include(wire, "wsse:UsernameToken")
      assert.include(wire, cf)
      assert.strictEqual(
        sent?.headers["soapaction"],
        '"http://demobank.example/soap/banking/cercaConti"'
      )
      assert.deepStrictEqual(
        sent?.secretHeaders.map(([name]) => name),
        ["authorization"]
      )

      const stored = yield* workspace.read(result.path)
      for (const secret of [
        "UsernameToken",
        "ws-secret",
        "basic-secret",
        "authorization",
        cf,
        iban,
        "Mario Rossi"
      ]) {
        assert.notInclude(stored, secret)
      }
      const exchange = result.exchange
      assert.strictEqual(exchange.environment, "dev")
      assert.strictEqual(exchange.endpoint, "https://demobank-dev.example.internal/soap/DemoBank")
      assert.deepStrictEqual(exchange.responseIssues, [])
      assert.isTrue(exchange.masking.entries.some((entry) => entry.kind === "iban"))
      const maskedIban =
        /<ban:iban>([^<]+)<\/ban:iban>/.exec(exchange.response?.envelope ?? "")?.[1] ?? ""
      assert.isTrue(isValidIban(maskedIban))

      assert.match(
        yield* workspace.read(`${servicePaths(service).directory}/.masking-key`),
        /^[0-9a-f]{64}\n$/
      )
      assert.include(yield* workspace.read(servicePaths(service).gitignore), ".masking-key")
    })
  )

  it.effect("never sends a request that does not validate", () =>
    Effect.gen(function* () {
      const { catalog, workspace, profile, fake, operations } = yield* setup()
      yield* writeRequest(workspace, catalog, "cercaConti", "broken", { codiceFiscale: "nope" })
      const error = yield* Effect.flip(
        callOperation({
          workspace,
          catalog,
          service,
          operation: "cercaConti",
          name: "broken",
          profile,
          operations,
          secrets,
          transport: fake.transport,
          allowMutating: undefined,
          confirm: noMutation
        })
      )
      assert.strictEqual(error._tag, "RequestInvalid")
      assert.lengthOf(yield* fake.requests, 0)
    })
  )

  it.effect("refuses unconfirmed classes and unflagged mutating calls in test", () =>
    Effect.gen(function* () {
      const { catalog, workspace, profile, fake } = yield* setup("test")
      const confirmed = yield* operationsFile
      yield* writeRequest(workspace, catalog, "revocaBonifico", "gia-eseguito", {
        idBonifico: "BN20260301009"
      })
      const base = {
        workspace,
        catalog,
        service,
        operation: "revocaBonifico",
        name: "gia-eseguito",
        profile,
        secrets,
        transport: fake.transport,
        confirm: () => Effect.succeed(true)
      }
      const unconfirmed = yield* Effect.flip(
        callOperation({ ...base, operations: undefined, allowMutating: "revocaBonifico" })
      )
      assert.strictEqual(unconfirmed._tag, "CallRefused")
      const unflagged = yield* Effect.flip(
        callOperation({ ...base, operations: confirmed, allowMutating: undefined })
      )
      assert.include(unflagged.message, "--allow-mutating revocaBonifico")
      assert.lengthOf(yield* fake.requests, 0)

      const result = yield* callOperation({
        ...base,
        operations: confirmed,
        allowMutating: "revocaBonifico"
      })
      assert.strictEqual(result.permission.allowedBy, "flag")
      assert.strictEqual(result.exchange.fault?.detailElement, "ServizioFault")
      assert.strictEqual(result.exchange.fault?.reason, "Bonifico gia eseguito")
    })
  )

  it.effect("records where a response breaks its schema", () =>
    Effect.gen(function* () {
      const { catalog, workspace, profile, operations } = yield* setup()
      const odd = readFileSync(`${demoResponses}/cercaConti.xml`, "utf8").replace(
        ">ATTIVO<",
        ">SOSPESO<"
      )
      const fake = yield* makeFakeSoapTransport(() =>
        Effect.succeed({
          status: 200,
          headers: {},
          body: new TextEncoder().encode(odd),
          elapsedMs: 3
        })
      )
      yield* writeRequest(workspace, catalog, "cercaConti", "odd", { codiceFiscale: cf })
      const result = yield* callOperation({
        workspace,
        catalog,
        service,
        operation: "cercaConti",
        name: "odd",
        profile,
        operations,
        secrets,
        transport: fake.transport,
        allowMutating: undefined,
        confirm: noMutation
      })
      assert.isTrue(result.exchange.responseIssues.some((issue) => issue.path === "conto[0].stato"))
    })
  )

  it.effect("accepts the raw XML request form", () =>
    Effect.gen(function* () {
      const { catalog, workspace, profile, fake, operations } = yield* setup()
      yield* workspace.write(
        samplePaths(service, "dettaglioConto", "raw-xml").xml,
        `<!-- purpose: from a SoapUI copy-paste -->\n<b:dettaglioConto xmlns:b="http://demobank.example/soap/banking"><b:iban>${iban}</b:iban></b:dettaglioConto>`
      )
      const result = yield* callOperation({
        workspace,
        catalog,
        service,
        operation: "dettaglioConto",
        name: "raw-xml",
        profile,
        operations,
        secrets,
        transport: fake.transport,
        allowMutating: undefined,
        confirm: noMutation
      })
      assert.strictEqual(result.exchange.purpose, "from a SoapUI copy-paste")
      assert.deepStrictEqual(yield* listRequests(workspace, service, "dettaglioConto"), ["raw-xml"])
    })
  )
})

describe("SoapUI import", () => {
  it.effect("writes masked request files and mock exchanges, never credentials", () =>
    Effect.gen(function* () {
      const catalog = yield* demoCatalog
      const workspace = yield* makeMemoryWorkspace()
      const report = yield* importSoapUiProject({
        workspace,
        catalog,
        service,
        project: readFileSync(demoSoapUi, "utf8"),
        key: fixedKey
      })
      assert.strictEqual(report.credentialsIgnored, 1)
      assert.deepStrictEqual(
        report.requests.map((request) => `${request.operation}/${request.name}`).sort(),
        [
          "cercaConti/soapui-conti-attivi",
          "cercaMovimenti/soapui-regressione-movimenti-marzo-prima-pagina",
          "dettaglioConto/soapui-request-1"
        ]
      )
      const placeholder = report.requests.find((request) => request.operation === "dettaglioConto")
      assert.isTrue(placeholder?.issues.some((issue) => issue.detail.includes("placeholders")))
      assert.lengthOf(report.responses, 2)

      const files = yield* workspace.discover(".llm4ts/**")
      for (const file of files) {
        const text = yield* workspace.read(file)
        for (const leak of ["dummy-password-never-import", "svc-demo", cf, iban, "Mario Rossi"]) {
          assert.notInclude(text, leak, file)
        }
      }
      const exchanges = yield* readExchanges(workspace, service, "cercaConti")
      const issues = exchanges.flatMap((exchange) =>
        exchange.responseIssues.map((issue) => issue.path)
      )
      assert.includeMembers(issues, ["conto[0].stato", "conto[0].canale"])

      const conferma = yield* readExchanges(workspace, service, "confermaBonifico")
      assert.include(conferma[0]?.response?.envelope ?? "", "KO17")

      // Mock exchanges carry no request; imported request files do, masked.
      assert.deepStrictEqual(yield* seedsFromExchanges(exchanges, catalog), new Map())
      const seeds = yield* seedsForService(workspace, catalog, service)
      assert.isTrue(isValidIban(seeds.get("iban") ?? ""))
      assert.notStrictEqual(seeds.get("iban"), iban)
      assert.isDefined(seeds.get("codiceFiscale"))
    })
  )

  it.effect("keeps existing request files", () =>
    Effect.gen(function* () {
      const catalog = yield* demoCatalog
      const workspace = yield* makeMemoryWorkspace({
        initial: { [samplePaths(service, "cercaConti", "soapui-conti-attivi").yaml]: "mine" }
      })
      const report = yield* importSoapUiProject({
        workspace,
        catalog,
        service,
        project: readFileSync(demoSoapUi, "utf8"),
        key: fixedKey
      })
      assert.isTrue(report.skipped.some((line) => line.includes("kept it")))
      assert.strictEqual(
        yield* workspace.read(samplePaths(service, "cercaConti", "soapui-conti-attivi").yaml),
        "mine"
      )
    })
  )
})

describe("scenario proposals", () => {
  it.effect(
    "writes proposed bodies as request files, with problems listed and existing files kept",
    () =>
      Effect.gen(function* () {
        const catalog = yield* demoCatalog
        const workspace = yield* makeMemoryWorkspace({
          initial: { [samplePaths(service, "cercaMovimenti", "empty-window").yaml]: "keep me" }
        })
        const body = (dimensione: number) => ({
          iban,
          dataDa: "2026-03-01",
          dataA: "2026-03-31",
          paginazione: { numeroPagina: 1, dimensionePagina: dimensione }
        })
        const reply = JSON.stringify({
          scenarios: [
            { name: "Happy Path", purpose: "one full page", body: body(50) },
            { name: "page-too-big", purpose: "above the page limit", body: body(500) },
            { name: "empty-window", purpose: "no movements", body: body(10) }
          ]
        })
        const written = yield* proposeScenarios({
          reasoning: replyingService(reply),
          workspace,
          catalog,
          service,
          operation: "cercaMovimenti",
          operationClass: "read",
          seeds: new Map([["iban", iban]])
        })
        assert.deepStrictEqual(
          written.map((scenario) => [scenario.name, scenario.issues.length > 0, scenario.kept]),
          [
            ["happy-path", false, false],
            ["page-too-big", true, false],
            ["empty-window", false, true]
          ]
        )
        const tooBig = yield* workspace.read(
          samplePaths(service, "cercaMovimenti", "page-too-big").yaml
        )
        assert.include(tooBig, "# To fix before calling:")
        assert.include(tooBig, "dimensionePagina: 500")
        assert.strictEqual(
          yield* workspace.read(samplePaths(service, "cercaMovimenti", "empty-window").yaml),
          "keep me"
        )
      })
  )
})
