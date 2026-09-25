import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ApiDesign,
  blockingIssues,
  checkDesign,
  type DesignIssue,
  parseDesignFile,
  renderDesignFile
} from "../flows/lib/soap/Design.ts"
import { designPrompt, proposeDesign, reviseDesign } from "../flows/lib/soap/DesignProposal.ts"
import { mapService } from "../flows/lib/soap/Mapping.ts"
import { projectOpenApi, renderTypedYaml } from "../flows/lib/soap/OpenApi.ts"
import { fixtureRoot, recordedEvidence, replyingService } from "./support.ts"

const referenceDesign = parseDesignFile(
  readFileSync(join(fixtureRoot, "design", "api-design.md"), "utf8")
)

type Encoded = typeof ApiDesign.Encoded
const edit = (design: ApiDesign, change: (encoded: Encoded) => Encoded): ApiDesign =>
  Schema.decodeUnknownSync(ApiDesign)(change(structuredClone(Schema.encodeSync(ApiDesign)(design))))

const errorsOf = (issues: ReadonlyArray<DesignIssue>) =>
  blockingIssues(issues).map((issue) => `${issue.where}: ${issue.detail}`)

describe("1:1 mapping", () => {
  it.effect("maps every XSD path to a JSON path and type", () =>
    Effect.gen(function* () {
      const { catalog } = yield* recordedEvidence
      const conti = mapService(catalog).operations.find(
        (operation) => operation.operation === "cercaConti"
      )
      const field = (xsd: string) =>
        conti?.responseFields.find((candidate) => candidate.xsd === xsd)
      assert.deepStrictEqual(
        [
          field("conto[].saldo.valore")?.json,
          field("conto[].saldo.valore")?.jsonType,
          field("conto[].saldo.valore")?.format
        ],
        ["$.conto[*].saldo.valore", "string", "decimal"]
      )
      assert.strictEqual(field("conto[]")?.jsonType, "array")
      assert.deepStrictEqual(field("conto[].stato")?.enumeration, ["ATTIVO", "BLOCCATO", "ESTINTO"])
      assert.strictEqual(field("conto[].dataApertura")?.format, "date")
    })
  )
})

describe("design check", () => {
  it.effect("accepts the reference design without errors", () =>
    Effect.gen(function* () {
      const { catalog, operations, analyses } = yield* recordedEvidence
      const file = yield* referenceDesign
      assert.isTrue(file.approved)
      const issues = checkDesign(file.design, { catalog, operations, analyses })
      assert.deepStrictEqual(errorsOf(issues), [])
      // What stays for a human: REST promises fields the XSD leaves optional.
      assert.isTrue(
        issues.some(
          (issue) =>
            issue.where === "model AccountDetail.account" &&
            issue.detail.includes("optional in the XSD")
        )
      )
    })
  )

  it.effect("rejects uncovered operations, unmapped enum values, and wrong verbs", () =>
    Effect.gen(function* () {
      const { catalog, operations, analyses } = yield* recordedEvidence
      const { design } = yield* referenceDesign
      const context = { catalog, operations, analyses }

      const uncovered = edit(design, (encoded) => ({
        ...encoded,
        endpoints: encoded.endpoints.filter(
          (endpoint) => endpoint.operationId !== "revokeCreditTransfer"
        )
      }))
      assert.include(
        errorsOf(checkDesign(uncovered, context)),
        "revocaBonifico: not exposed by any endpoint and not excluded"
      )

      const excluded = edit(uncovered, (encoded) => ({
        ...encoded,
        excluded: [{ operation: "revocaBonifico", reason: "handled by the back office" }]
      }))
      assert.deepStrictEqual(errorsOf(checkDesign(excluded, context)), [])

      const noSuspended = edit(design, (encoded) => ({
        ...encoded,
        models: encoded.models.map((model) =>
          model.name !== "Account"
            ? model
            : {
                ...model,
                properties: model.properties.map((property) =>
                  property.name === "status"
                    ? {
                        ...property,
                        enum: ["ACTIVE", "BLOCKED", "CLOSED"],
                        enumMap: { ATTIVO: "ACTIVE", BLOCCATO: "BLOCKED", ESTINTO: "CLOSED" }
                      }
                    : property
                )
              }
        )
      }))
      assert.include(
        errorsOf(checkDesign(noSuspended, context)),
        "model Account.status: enumMap has no entry for SOAP value SOSPESO (seen in samples)"
      )

      const getMutating = edit(design, (encoded) => ({
        ...encoded,
        endpoints: encoded.endpoints.map((endpoint) =>
          endpoint.operationId === "revokeCreditTransfer"
            ? { ...endpoint, method: "GET" as const }
            : endpoint
        )
      }))
      assert.include(
        errorsOf(checkDesign(getMutating, context)),
        "GET /credit-transfers/{transferId}/revocation: GET must not call a mutating operation"
      )
    })
  )

  it.effect("checks sources against the XSD and warns on unmapped business errors", () =>
    Effect.gen(function* () {
      const { catalog, operations, analyses } = yield* recordedEvidence
      const { design } = yield* referenceDesign
      const context = { catalog, operations, analyses }
      const broken = edit(design, (encoded) => ({
        ...encoded,
        models: encoded.models.map((model) =>
          model.name === "Movement"
            ? {
                ...model,
                properties: model.properties.map((property) =>
                  property.name === "reason" ? { ...property, source: "causaleEstesa" } : property
                )
              }
            : model
        ),
        endpoints: encoded.endpoints.map((endpoint) =>
          endpoint.operationId === "confirmCreditTransfer"
            ? {
                ...endpoint,
                errors: [],
                responses: [{ status: 200, description: "x", model: "Movement", source: "" }]
              }
            : endpoint
        )
      }))
      const issues = checkDesign(broken, context)
      const errors = errorsOf(issues)
      assert.include(
        errors,
        "model Movement.reason: source causaleEstesa is not a path of MovimentoType"
      )
      assert.isTrue(
        errors.some((line) => line.includes("model Movement is bound to MovimentoType"))
      )
      assert.isTrue(
        issues.some(
          (issue) =>
            issue.severity === "warning" &&
            issue.detail.includes("outcome KO17 (Codice OTP non valido)")
        )
      )
    })
  )

  it.effect("renders a design file that parses back to the same design", () =>
    Effect.gen(function* () {
      const { design } = yield* referenceDesign
      const text = renderDesignFile(design, [{ severity: "warning", where: "x", detail: "y" }])
      const back = yield* parseDesignFile(text)
      assert.isFalse(back.approved)
      assert.deepStrictEqual(
        Schema.encodeSync(ApiDesign)(back.design),
        Schema.encodeSync(ApiDesign)(design)
      )
      assert.include(text, "| GET | /v1/accounts/{iban}/movements | cercaMovimenti |")
    })
  )
})

const at = (value: Schema.Json, ...keys: ReadonlyArray<string | number>): Schema.Json | undefined =>
  keys.reduce<Schema.Json | undefined>((current, key) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined
    const entries: ReadonlyArray<readonly [string, Schema.Json]> = Object.entries(current)
    return entries.find(([name]) => name === String(key))?.[1]
  }, value)

describe("OpenAPI projection", () => {
  it.effect("projects models, lists, problems, and SOAP traceability", () =>
    Effect.gen(function* () {
      const { design } = yield* referenceDesign
      const api = projectOpenApi(design)
      assert.strictEqual(at(api, "openapi"), "3.1.0")
      assert.strictEqual(at(api, "servers", 0, "url"), "/v1")
      const movements = at(api, "paths", "/accounts/{iban}/movements", "get")
      assert.strictEqual(at(movements ?? null, "operationId"), "listMovements")
      assert.deepStrictEqual(at(movements ?? null, "x-soap-operations"), ["cercaMovimenti"])
      assert.deepStrictEqual(
        at(movements ?? null, "responses", "200", "content", "application/json", "schema"),
        {
          $ref: "#/components/schemas/MovementPage"
        }
      )
      assert.deepStrictEqual(
        at(api, "components", "schemas", "MovementPage", "properties", "page"),
        {
          $ref: "#/components/schemas/PageInfo"
        }
      )
      const create = at(api, "paths", "/credit-transfers", "post")
      assert.isDefined(at(create ?? null, "responses", "201", "headers", "Location"))
      assert.deepStrictEqual(at(create ?? null, "responses", "422", "x-problem-codes", 0, "from"), [
        "ServizioFault"
      ])
      assert.deepStrictEqual(
        at(create ?? null, "responses", "502", "content", "application/problem+json", "schema"),
        {
          $ref: "#/components/schemas/Problem"
        }
      )
      const status = at(api, "components", "schemas", "Account", "properties", "status")
      assert.strictEqual(at(status ?? null, "x-soap-source"), "stato")
      assert.strictEqual(at(status ?? null, "x-soap-enum-map", "SOSPESO"), "SUSPENDED")
      assert.deepStrictEqual(
        at(api, "components", "schemas", "AccountDetail", "properties", "overdraftLimit", "oneOf"),
        [{ $ref: "#/components/schemas/Amount" }, { type: "null" }]
      )
      assert.deepStrictEqual(at(api, "components", "schemas", "Problem", "required"), [
        "type",
        "title",
        "status",
        "code"
      ])

      const yaml = renderTypedYaml(api)
      assert.match(yaml, /^openapi: 3\.1\.0\n/)
      assert.include(yaml, "  /accounts/{iban}/movements:\n    get:\n")
      assert.include(yaml, '$ref: "#/components/schemas/MovementPage"')
    })
  )

  it.effect("projects an OpenAPI 3.0.3 variant for IBM ACE 12", () =>
    Effect.gen(function* () {
      const { design } = yield* referenceDesign
      const api = projectOpenApi(design, { dialect: "3.0" })
      assert.strictEqual(at(api, "openapi"), "3.0.3")
      assert.deepStrictEqual(
        at(api, "components", "schemas", "AccountDetail", "properties", "overdraftLimit", "allOf"),
        [{ $ref: "#/components/schemas/Amount" }]
      )
      assert.strictEqual(
        at(
          api,
          "components",
          "schemas",
          "AccountDetail",
          "properties",
          "overdraftLimit",
          "nullable"
        ),
        true
      )
      assert.strictEqual(
        at(api, "components", "schemas", "Account", "properties", "branch", "type"),
        "string"
      )
      assert.isUndefined(
        at(api, "components", "schemas", "Account", "properties", "balance", "$ref")
      )
    })
  )

  it("quotes strings a YAML reader would retype", () => {
    assert.strictEqual(
      renderTypedYaml({
        a: "01",
        b: "true",
        c: "2026-01-01",
        d: 1,
        e: true,
        f: null,
        g: "plain",
        h: ["yes", "D"]
      }),
      'a: "01"\nb: "true"\nc: "2026-01-01"\nd: 1\ne: true\nf: null\ng: plain\nh:\n  - "yes"\n  - D\n'
    )
  })
})

describe("design proposal", () => {
  it.effect("prompts with style, classes, mapping, and evidence, and decodes the reply", () =>
    Effect.gen(function* () {
      const { catalog, operations, analyses } = yield* recordedEvidence
      const { design } = yield* referenceDesign
      const options = {
        catalog,
        operations,
        mapping: mapService(catalog),
        analyses,
        style: "STYLE-GUIDE-TEXT"
      }
      const prompt = designPrompt(options)
      assert.include(prompt, "STYLE-GUIDE-TEXT")
      assert.include(prompt, "- revocaBonifico [mutating]")
      assert.include(prompt, "    conto[].stato: string StatoConto enum ATTIVO|BLOCCATO|ESTINTO")
      assert.include(prompt, "values outside the declared enumeration: SOSPESO")
      assert.include(prompt, 'outcome KO17 "Codice OTP non valido"')
      const reply = JSON.stringify(Schema.encodeSync(ApiDesign)(design))
      const drafted = yield* proposeDesign(replyingService(reply), options)
      assert.strictEqual(drafted.endpoints.length, 6)
      const revised = yield* reviseDesign(replyingService(reply), {
        ...options,
        current: drafted,
        issues: []
      })
      assert.strictEqual(revised.models.length, design.models.length)
    })
  )
})
