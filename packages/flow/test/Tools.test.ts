import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { PlainFileStore, makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { builtinTool, builtinTools } from "@llm4ts/flow/tools/Builtin"
import { diff } from "@llm4ts/flow/tools/Diff"
import { jsonValidate } from "@llm4ts/flow/tools/JsonValidate"
import {
  ToolReport,
  capReport,
  parseToolArgs,
  renderReport,
  renderSpec,
  renderUsage,
  specOf
} from "@llm4ts/flow/tools/Tool"

const withFiles = (files: Readonly<Record<string, string>>) =>
  Effect.map(makeMemoryPlainFileStore(files), (memory) => memory.store)

describe("tool contract", () => {
  const spec = specOf(diff)

  it.effect("parses --flag value pairs, =forms, defaults and boolean flags by kind", () =>
    Effect.gen(function* () {
      const values = yield* parseToolArgs(spec, [
        "--expected",
        "a.json",
        "--actual=b.json",
        "--ordering",
        "per-key"
      ])
      assert.deepStrictEqual(values, {
        expected: "a.json",
        actual: "b.json",
        ordering: "per-key",
        ignore: ""
      })
      const flag = specOf({
        name: "t",
        purpose: "p",
        args: {
          strict: { description: "s", kind: "boolean" },
          limit: { description: "l", kind: "integer", default: "3" },
          body: { description: "b", kind: "json" }
        }
      })
      assert.deepStrictEqual(yield* parseToolArgs(flag, ["--strict", "--body", '{"a":1}']), {
        strict: true,
        limit: 3,
        body: { a: 1 }
      })
      assert.deepStrictEqual(yield* parseToolArgs(flag, ["--strict", "false", "--limit=7"]), {
        strict: false,
        limit: 7
      })
    })
  )

  it.effect(
    "refuses unknown names, missing required arguments and bad kinds, quoting the spec",
    () =>
      Effect.gen(function* () {
        const unknown = yield* Effect.flip(parseToolArgs(spec, ["--nope", "x"]))
        assert.match(unknown.message, /unknown argument '--nope'/)
        assert.include(unknown.message, "--expected <path> (required)")
        const missing = yield* Effect.flip(parseToolArgs(spec, ["--expected", "a.json"]))
        assert.match(missing.message, /missing required argument '--actual'/)
        const bare = yield* Effect.flip(parseToolArgs(spec, ["a.json"]))
        assert.match(bare.message, /unexpected argument 'a.json'/)
        const integer = specOf({
          name: "t",
          purpose: "p",
          args: { n: { description: "n", kind: "integer" } }
        })
        const bad = yield* Effect.flip(parseToolArgs(integer, ["--n", "two"]))
        assert.match(bad.message, /expects an integer/)
      })
  )

  it("renders the describe text and the one-line usage", () => {
    assert.strictEqual(
      renderUsage(spec),
      "diff --expected <path> --actual <path> [--ordering <string>] [--ignore <string>]"
    )
    const text = renderSpec(spec)
    assert.include(text, "diff: Compare two JSON documents")
    assert.include(text, "--ordering <string> [default ordered]:")
  })

  it("caps a report at 50 issues unless all is asked, and renders text", () => {
    const issues = Array.from({ length: 60 }, (_, index) => ({
      path: `$.items[${index}]`,
      detail: "changed"
    }))
    const full = ToolReport.make({
      tool: "diff",
      ok: false,
      summary: "60 issues",
      issues,
      truncated: 0
    })
    const capped = capReport(full, false)
    assert.strictEqual(capped.issues.length, 50)
    assert.strictEqual(capped.truncated, 10)
    assert.strictEqual(capReport(full, true).issues.length, 60)
    const text = renderReport(capped)
    assert.match(text, /^FAIL diff: 60 issues/)
    assert.include(text, "… 10 more (run with --all)")
  })

  it("lists the built-in tools by name", () => {
    assert.deepStrictEqual(
      builtinTools.map((tool) => tool.name),
      ["json-validate", "diff"]
    )
    assert.strictEqual(builtinTool("diff")?.name, "diff")
    assert.isUndefined(builtinTool("nope"))
  })
})

describe("json-validate", () => {
  const schema = JSON.stringify({
    type: "object",
    required: ["id", "amount"],
    properties: {
      id: { type: "string" },
      amount: { type: "number", minimum: 0 },
      currency: { type: "string", enum: ["EUR", "USD"] }
    },
    additionalProperties: false
  })
  const openapi = JSON.stringify({
    openapi: "3.0.0",
    components: {
      schemas: {
        Money: {
          type: "object",
          required: ["amount"],
          properties: { amount: { $ref: "#/components/schemas/Amount" } }
        },
        Amount: { type: "number", minimum: 0 }
      }
    }
  })

  it.effect("passes a valid document and reports every issue of an invalid one", () =>
    Effect.gen(function* () {
      const files = yield* withFiles({
        "schema.json": schema,
        "good.json": '{"id":"a1","amount":10,"currency":"EUR"}',
        "bad.json": '{"amount":-1,"currency":"GBP","extra":true}'
      })
      const good = yield* jsonValidate
        .execute({ document: "good.json", schema: "schema.json" })
        .pipe(Effect.provideService(PlainFileStore, files))
      assert.isTrue(good.ok)
      assert.strictEqual(good.summary, "good.json is valid against schema.json")
      const bad = yield* jsonValidate
        .execute({ document: "bad.json", schema: "schema.json" })
        .pipe(Effect.provideService(PlainFileStore, files))
      assert.isFalse(bad.ok)
      const details = bad.issues.map((issue) => `${issue.path}: ${issue.detail}`)
      assert.isTrue(details.some((line) => /missing required property "id"/.test(line)))
      assert.isTrue(details.some((line) => /\$\.amount/.test(line)))
      assert.isTrue(details.some((line) => /\$\.currency/.test(line)))
      assert.isTrue(details.some((line) => /unexpected property "extra"/.test(line)))
    })
  )

  it.effect("validates against an OpenAPI component and resolves its $refs", () =>
    Effect.gen(function* () {
      const files = yield* withFiles({
        "openapi.json": openapi,
        "money.json": '{"amount":-5}'
      })
      const report = yield* jsonValidate
        .execute({ document: "money.json", openapi: "openapi.json", component: "Money" })
        .pipe(Effect.provideService(PlainFileStore, files))
      assert.isFalse(report.ok)
      assert.strictEqual(report.issues[0]?.path, "$.amount")
      const unknown = yield* Effect.flip(
        jsonValidate
          .execute({ document: "money.json", openapi: "openapi.json", component: "Nope" })
          .pipe(Effect.provideService(PlainFileStore, files))
      )
      assert.match(unknown.message, /no component schema 'Nope'; known: Amount, Money/)
    })
  )

  it.effect("names a missing file, invalid JSON and a missing schema choice", () =>
    Effect.gen(function* () {
      const files = yield* withFiles({ "broken.json": "{", "schema.json": schema })
      const missing = yield* Effect.flip(
        jsonValidate
          .execute({ document: "absent.json", schema: "schema.json" })
          .pipe(Effect.provideService(PlainFileStore, files))
      )
      assert.strictEqual(missing.message, "no such file: absent.json")
      const broken = yield* Effect.flip(
        jsonValidate
          .execute({ document: "broken.json", schema: "schema.json" })
          .pipe(Effect.provideService(PlainFileStore, files))
      )
      assert.match(broken.message, /broken\.json is not valid JSON/)
      const none = yield* Effect.flip(
        jsonValidate
          .execute({ document: "schema.json" })
          .pipe(Effect.provideService(PlainFileStore, files))
      )
      assert.match(none.message, /give --schema <file> or --openapi/)
    })
  )
})

describe("diff tool", () => {
  it.effect("compares two documents with the ordering and ignore rules", () =>
    Effect.gen(function* () {
      const files = yield* withFiles({
        "expected.json": '{"items":[{"id":1,"v":"a"},{"id":2,"v":"b"}],"meta":{"requestId":"x"}}',
        "actual.json": '{"items":[{"id":2,"v":"b"},{"id":1,"v":"c"}],"meta":{"requestId":"y"}}'
      })
      const ordered = yield* diff
        .execute({
          expected: "expected.json",
          actual: "actual.json",
          ordering: "ordered",
          ignore: ""
        })
        .pipe(Effect.provideService(PlainFileStore, files))
      assert.isFalse(ordered.ok)
      const perKey = yield* diff
        .execute({
          expected: "expected.json",
          actual: "actual.json",
          ordering: "per-key",
          ignore: "meta.requestId"
        })
        .pipe(Effect.provideService(PlainFileStore, files))
      assert.strictEqual(perKey.issues.length, 1)
      assert.strictEqual(perKey.issues[0]?.path, "$.items[id=1].v")
      assert.match(perKey.issues[0]?.detail ?? "", /^changed: /)
      const same = yield* diff
        .execute({
          expected: "expected.json",
          actual: "expected.json",
          ordering: "ordered",
          ignore: ""
        })
        .pipe(Effect.provideService(PlainFileStore, files))
      assert.isTrue(same.ok)
      assert.strictEqual(same.summary, "expected.json matches expected.json")
    })
  )
})
