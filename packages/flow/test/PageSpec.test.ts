import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  FieldMapping,
  PageApiCall,
  PageForm,
  PageFormField,
  PageSpec,
  PageValidation,
  openApiFor,
  pageSpecBlock,
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
