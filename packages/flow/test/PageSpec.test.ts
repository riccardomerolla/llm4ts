import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  ContractConflict,
  FieldMapping,
  openApiFor,
  openApiForFeature,
  PageApiCall,
  PageDto,
  PageForm,
  PageFormField,
  PageSpec,
  pageSpecBlock,
  PageValidation,
  parsePageSpec,
  renderPageSpec,
  renderPageSpecBlock
} from "@llm4ts/flow/PageSpec"

const transferSpec = PageSpec.make({
  page: "TransferStep1",
  route: "/transfer/step1",
  title: "Wire transfer — amount",
  complexity: "high",
  forms: [
    PageForm.make({
      name: "transferForm",
      action: "/app/transfer",
      fields: [
        PageFormField.make({
          name: "amount",
          label: "Amount",
          type: "decimal",
          required: true,
          validations: [
            PageValidation.make({
              rule: "min 0.01",
              message: "Amount must be positive",
              enforcedAt: "both"
            })
          ]
        })
      ]
    })
  ],
  apiCalls: [
    PageApiCall.make({
      operation: "validateTransfer",
      method: "POST",
      path: "/transfers/validate",
      esbService: "ESB_TRF_VAL",
      request: [
        FieldMapping.make({ legacyName: "trfAmt", domainName: "amount", type: "decimal" }),
        FieldMapping.make({ legacyName: "benfId", domainName: "beneficiaryId", type: "string" })
      ],
      response: [FieldMapping.make({ legacyName: "valSts", domainName: "status", type: "string" })]
    }),
    PageApiCall.make({
      operation: "listBeneficiaries",
      method: "GET",
      path: "/beneficiaries",
      request: [
        FieldMapping.make({ legacyName: "custNo", domainName: "customerId", type: "string" })
      ],
      response: [FieldMapping.make({ legacyName: "benfNm", domainName: "name", type: "string" })]
    })
  ],
  sessionState: ["TransferDraft held in HttpSession across steps 1-3"],
  openQuestions: ["Is the daily limit enforced client-side anywhere?"]
})

describe("PageSpec", () => {
  it.effect("round-trips through the fenced block", () =>
    Effect.gen(function* () {
      const block = yield* renderPageSpecBlock(transferSpec)
      const markdown = `# Spec: TransferStep1\n\nProse first.\n\n${block}\n\nProse after.\n`
      const parsed = yield* parsePageSpec(markdown)

      assert.strictEqual(pageSpecBlock(markdown)?.startsWith("{"), true)
      assert.strictEqual(parsed.page, "TransferStep1")
      assert.strictEqual(parsed.complexity, "high")
      assert.strictEqual(parsed.forms[0]?.fields[0]?.validations[0]?.enforcedAt, "both")
      assert.strictEqual(parsed.apiCalls.length, 2)
      assert.strictEqual(parsed.apiCalls[0]?.esbService, "ESB_TRF_VAL")
    })
  )

  it.effect("fails typed on a missing or malformed block", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(parsePageSpec("# Spec with no block\n"))
      const malformed = yield* Effect.flip(parsePageSpec('```json pagespec\n{"page": "X"}\n```'))

      assert.strictEqual(missing._tag, "PlanParse")
      assert.include(missing.message, "pagespec")
      assert.strictEqual(malformed._tag, "PlanParse")
    })
  )

  it("emits a deterministic OpenAPI contract in domain names", () => {
    const yaml = openApiFor(transferSpec)

    assert.include(yaml, "openapi: 3.0.3")
    assert.include(yaml, "/transfers/validate:")
    assert.include(yaml, "operationId: validateTransfer")
    assert.include(yaml, "backed by ESB service ESB_TRF_VAL")
    assert.include(yaml, "ValidateTransferRequest")
    assert.include(yaml, "ValidateTransferResponse")
    assert.include(yaml, "beneficiaryId")
    // GET requests carry query parameters, never a request body.
    assert.include(yaml, "- name: customerId")
    assert.notInclude(yaml, "ListBeneficiariesRequest")
    // Domain names only; legacy names survive only as descriptions.
    assert.notInclude(yaml, "trfAmt:")
    assert.include(yaml, "legacy: trfAmt")
  })

  it("renders a human summary with forms, calls, and open questions", () => {
    const rendered = renderPageSpec(transferSpec)

    assert.include(rendered, "# Page: TransferStep1")
    assert.include(rendered, "amount (decimal) required")
    assert.include(rendered, "validateTransfer: POST /transfers/validate — ESB ESB_TRF_VAL")
    assert.include(rendered, "## Session state")
    assert.include(rendered, "## Open questions")
  })
})

describe("list responses", () => {
  it("references the DTO as a component and wraps a list response in an array", () => {
    const spec = PageSpec.make({
      page: "accountOverview",
      route: "/accountOverview",
      title: "Account Overview",
      complexity: "medium",
      dtos: [
        PageDto.make({
          legacyName: "AcctOvwDTO",
          domainName: "Account",
          fields: [
            FieldMapping.make({
              legacyName: "acctNo",
              domainName: "accountNumber",
              type: "String"
            }),
            FieldMapping.make({
              legacyName: "curBal",
              domainName: "currentBalance",
              type: "BigDecimal"
            })
          ]
        })
      ],
      apiCalls: [
        PageApiCall.make({
          operation: "listAccounts",
          method: "GET",
          path: "accountOverview",
          esbService: "ESB_ACCT_LIST",
          responseDto: "Account",
          responseShape: "list"
        })
      ]
    })
    const yaml = openApiFor(spec)
    assert.include(
      yaml,
      "  /accountOverview:",
      "paths are rooted even when the spec omits the slash"
    )
    assert.include(
      yaml,
      '                type: array\n                items:\n                  $ref: "#/components/schemas/Account"'
    )
    assert.include(
      yaml,
      '    Account:\n      type: object\n      description: "legacy: AcctOvwDTO"'
    )
    assert.include(yaml, "accountNumber:")
    assert.notInclude(
      yaml,
      "ListAccountsResponse",
      "a DTO-typed response has no ad-hoc response schema"
    )
    assert.include(
      renderPageSpec(spec),
      "listAccounts: GET accountOverview — ESB ESB_ACCT_LIST → list of Account"
    )
  })

  it("defaults to a single ad-hoc object when no DTO is named", () => {
    const spec = PageSpec.make({
      page: "profile",
      route: "/profile",
      title: "Profile",
      complexity: "low",
      apiCalls: [
        PageApiCall.make({
          operation: "getProfile",
          method: "GET",
          path: "/profile",
          response: [
            FieldMapping.make({ legacyName: "custNm", domainName: "customerName", type: "String" })
          ]
        })
      ]
    })
    const yaml = openApiFor(spec)
    assert.include(yaml, '                $ref: "#/components/schemas/GetProfileResponse"')
    assert.notInclude(yaml, "type: array")
  })
})

describe("calls sharing a method and path", () => {
  it("emits one operation per method and names the variants it stands for", () => {
    const spec = PageSpec.make({
      page: "accountOverview",
      route: "/accountOverview",
      title: "Account Overview",
      complexity: "medium",
      apiCalls: [
        PageApiCall.make({
          operation: "loadAccountOverview",
          method: "GET",
          path: "/accountOverview"
        }),
        PageApiCall.make({
          operation: "refreshAccountBalances",
          method: "GET",
          path: "/accountOverview",
          esbService: "ESB_ACCT_LIST"
        })
      ]
    })
    const yaml = openApiFor(spec)
    assert.strictEqual((yaml.match(/^ {4}get:$/gm) ?? []).length, 1, "a path item holds one get")
    assert.include(yaml, "operationId: loadAccountOverview")
    assert.include(yaml, 'description: "also serves: refreshAccountBalances"')
    assert.include(yaml, "LoadAccountOverviewResponse:")
  })
})

describe("esbService", () => {
  it.effect("accepts an identifier and rejects prose", () =>
    Effect.gen(function* () {
      const block = (esbService: string): string =>
        "# p\n\n```json pagespec\n" +
        JSON.stringify({
          page: "p",
          route: "/p",
          title: "P",
          complexity: "low",
          apiCalls: [{ operation: "load", method: "GET", path: "/p", esbService }]
        }) +
        "\n```\n"
      const ok = yield* parsePageSpec(block("ESB_ACCT_LIST"))
      assert.strictEqual(ok.apiCalls[0]?.esbService, "ESB_ACCT_LIST")
      const error = yield* parsePageSpec(
        block("UNKNOWN — called inside the servlet, out of scope")
      ).pipe(Effect.flip)
      assert.strictEqual(error._tag, "PlanParse")
    })
  )
})

describe("feature contracts (ADR 0012 addendum)", () => {
  const listCall = PageApiCall.make({
    operation: "listBeneficiaries",
    method: "GET",
    path: "/beneficiaries",
    esbService: "ESB_BENF_LIST",
    request: [],
    response: [],
    responseDto: "Beneficiary",
    responseShape: "list"
  })
  const beneficiary = PageDto.make({
    legacyName: "BenfDTO",
    domainName: "Beneficiary",
    fields: [FieldMapping.make({ legacyName: "BENF_ID", domainName: "id", type: "string" })]
  })
  const page = (name: string, calls: ReadonlyArray<PageApiCall>, dtos = [beneficiary]) =>
    PageSpec.make({
      page: name,
      route: `/${name}`,
      title: name,
      complexity: "low",
      forms: [],
      apiCalls: calls,
      dtos,
      navigation: { inbound: [], outbound: [], steps: [] },
      sessionState: [],
      openQuestions: []
    })

  it.effect("unions identical operations across pages and records their origin", () =>
    Effect.gen(function* () {
      const save = PageApiCall.make({
        operation: "saveBeneficiary",
        method: "POST",
        path: "/beneficiaries",
        request: [FieldMapping.make({ legacyName: "BENF_NM", domainName: "name", type: "string" })],
        response: [],
        responseDto: "Beneficiary",
        responseShape: "single"
      })
      const contract = yield* openApiForFeature(
        { id: "beneficiary-maintenance", name: "Beneficiary maintenance" },
        [page("beneficiaryList", [listCall]), page("beneficiaryEdit", [listCall, save])]
      )
      assert.deepStrictEqual(contract.operations, [
        { key: "GET /beneficiaries", pages: ["beneficiaryList", "beneficiaryEdit"] },
        { key: "POST /beneficiaries", pages: ["beneficiaryEdit"] }
      ])
      assert.include(contract.yaml, "Beneficiary maintenance service contract")
      assert.include(
        contract.yaml,
        "domain feature beneficiary-maintenance — pages beneficiaryList, beneficiaryEdit"
      )
      assert.include(contract.yaml, "declared by pages beneficiaryList, beneficiaryEdit")
      assert.include(contract.yaml, "declared by page beneficiaryEdit")
      assert.strictEqual((contract.yaml.match(/operationId: listBeneficiaries/g) ?? []).length, 1)
      assert.include(contract.yaml, "    Beneficiary:")
    })
  )

  it.effect(
    "the same path with a different shape, or the same DTO with different fields, is a conflict",
    () =>
      Effect.gen(function* () {
        const otherShape = PageApiCall.make({ ...listCall, responseShape: "single" })
        const otherDto = PageDto.make({
          ...beneficiary,
          fields: [
            FieldMapping.make({
              legacyName: "BENF_ID",
              domainName: "beneficiaryId",
              type: "string"
            })
          ]
        })
        const failure = yield* openApiForFeature({ id: "f", name: "F" }, [
          page("a", [listCall]),
          page("b", [otherShape], [otherDto])
        ]).pipe(Effect.flip)
        assert.instanceOf(failure, ContractConflict)
        assert.deepStrictEqual(failure.conflicts, [
          "GET /beneficiaries differs between a (listBeneficiaries) and b (listBeneficiaries)",
          "DTO 'Beneficiary' has different fields in a and b"
        ])
      })
  )
})
