import { assert, describe, it } from "@effect/vitest"
import { validateJson } from "@llm4ts/flow/tools/JsonSchemaCheck"
import type { JsonIssue } from "@llm4ts/flow/tools/JsonSchemaCheck"

const details = (issues: ReadonlyArray<JsonIssue>): ReadonlyArray<string> =>
  issues.map((issue) => `${issue.path}: ${issue.detail}`)

describe("validateJson type keywords", () => {
  it("accepts a matching type and reports a mismatch with both type names", () => {
    assert.deepStrictEqual(validateJson({ type: "string" }, "x"), [])
    assert.deepStrictEqual(details(validateJson({ type: "string" }, 7)), [
      "$: expected string, found number"
    ])
    assert.deepStrictEqual(details(validateJson({ type: "object" }, [])), [
      "$: expected object, found array"
    ])
  })

  it("treats integer as a whole number and number as any number", () => {
    assert.deepStrictEqual(validateJson({ type: "integer" }, 3), [])
    assert.deepStrictEqual(details(validateJson({ type: "integer" }, 3.5)), [
      "$: expected integer, found number"
    ])
    assert.deepStrictEqual(validateJson({ type: "number" }, 3.5), [])
  })

  it("accepts a type list and names every alternative on a miss", () => {
    assert.deepStrictEqual(validateJson({ type: ["string", "null"] }, null), [])
    assert.deepStrictEqual(details(validateJson({ type: ["string", "null"] }, true)), [
      "$: expected string or null, found boolean"
    ])
  })

  it("lets nullable: true admit null and nothing else extra", () => {
    assert.deepStrictEqual(validateJson({ type: "string", nullable: true }, null), [])
    assert.deepStrictEqual(details(validateJson({ type: "string" }, null)), [
      "$: expected string, found null"
    ])
    assert.deepStrictEqual(details(validateJson({ type: "string", nullable: true }, 1)), [
      "$: expected string, found number"
    ])
  })

  it("accepts anything under true and rejects everything under false", () => {
    assert.deepStrictEqual(validateJson(true, { any: "thing" }), [])
    assert.deepStrictEqual(details(validateJson(false, 1)), [
      "$: value is not allowed by a false schema"
    ])
  })
})

describe("validateJson enum and const", () => {
  it("reports an enum miss with the allowed values", () => {
    assert.deepStrictEqual(validateJson({ enum: [1, 2, 3] }, 2), [])
    assert.deepStrictEqual(details(validateJson({ enum: [1, 2, 3] }, 7)), [
      "$: value 7 is not one of [1, 2, 3]"
    ])
  })

  it("compares enum members and const structurally", () => {
    assert.deepStrictEqual(validateJson({ enum: [{ a: 1 }] }, { a: 1 }), [])
    assert.deepStrictEqual(validateJson({ const: [1, "x"] }, [1, "x"]), [])
    assert.deepStrictEqual(details(validateJson({ const: "on" }, "off")), [
      '$: value "off" is not the constant "on"'
    ])
  })
})

describe("validateJson objects", () => {
  const schema = {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      tags: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
  }

  it("reports each missing required property", () => {
    assert.deepStrictEqual(details(validateJson(schema, {})), [
      '$: missing required property "id"',
      '$: missing required property "name"'
    ])
  })

  it("reports unexpected properties when additionalProperties is false", () => {
    assert.deepStrictEqual(details(validateJson(schema, { id: 1, name: "a", foo: 1 })), [
      '$: unexpected property "foo"'
    ])
  })

  it("validates extra properties against an additionalProperties schema", () => {
    const loose = { type: "object", additionalProperties: { type: "number" } }
    assert.deepStrictEqual(validateJson(loose, { a: 1, b: 2 }), [])
    assert.deepStrictEqual(details(validateJson(loose, { a: 1, b: "two" })), [
      "$.b: expected number, found string"
    ])
  })

  it("renders nested property and index paths", () => {
    assert.deepStrictEqual(details(validateJson(schema, { id: 1, name: "a", tags: ["x", 2] })), [
      "$.tags[1]: expected string, found number"
    ])
    const nested = {
      properties: { items: { items: { properties: { price: { type: "number" } } } } }
    }
    assert.deepStrictEqual(
      details(validateJson(nested, { items: [{ price: 1 }, { price: 2 }, { price: "3" }] })),
      ["$.items[2].price: expected number, found string"]
    )
  })

  it("quotes property names that are not identifiers", () => {
    const schema = { properties: { "content-type": { type: "string" } } }
    assert.deepStrictEqual(details(validateJson(schema, { "content-type": 1 })), [
      '$["content-type"]: expected string, found number'
    ])
  })

  it("reports every issue in one pass, in document order, without duplicates", () => {
    const issues = validateJson(schema, { name: 1, extra: true })
    assert.deepStrictEqual(details(issues), [
      '$: missing required property "id"',
      "$.name: expected string, found number",
      '$: unexpected property "extra"'
    ])
    const twice = { allOf: [{ required: ["id"] }, { required: ["id"] }] }
    assert.deepStrictEqual(details(validateJson(twice, {})), ['$: missing required property "id"'])
  })
})

describe("validateJson arrays", () => {
  it("validates every item against a single items schema", () => {
    assert.deepStrictEqual(details(validateJson({ items: { type: "integer" } }, [1, "b", 2.5])), [
      "$[1]: expected integer, found string",
      "$[2]: expected integer, found number"
    ])
  })

  it("checks minItems and maxItems", () => {
    assert.deepStrictEqual(details(validateJson({ minItems: 2 }, [1])), [
      "$: expected at least 2 items, found 1"
    ])
    assert.deepStrictEqual(details(validateJson({ maxItems: 1 }, [1, 2])), [
      "$: expected at most 1 items, found 2"
    ])
  })

  it("checks uniqueItems structurally", () => {
    assert.deepStrictEqual(validateJson({ uniqueItems: true }, [{ a: 1 }, { a: 2 }]), [])
    assert.deepStrictEqual(details(validateJson({ uniqueItems: true }, [{ a: 1 }, 2, { a: 1 }])), [
      "$: items are not unique: item 2 duplicates item 0"
    ])
  })
})

describe("validateJson strings", () => {
  it("checks minLength and maxLength in code points", () => {
    assert.deepStrictEqual(details(validateJson({ minLength: 3 }, "ab")), [
      "$: expected at least 3 characters, found 2"
    ])
    assert.deepStrictEqual(details(validateJson({ maxLength: 1 }, "ab")), [
      "$: expected at most 1 characters, found 2"
    ])
    assert.deepStrictEqual(validateJson({ maxLength: 1 }, "😀"), [])
  })

  it("checks pattern with the u flag", () => {
    assert.deepStrictEqual(validateJson({ pattern: "^\\p{L}+$" }, "héllo"), [])
    assert.deepStrictEqual(details(validateJson({ pattern: "^\\d+$" }, "12a")), [
      '$: value "12a" does not match pattern "^\\\\d+$"'
    ])
  })

  it("reports an invalid pattern once instead of throwing", () => {
    const schema = { items: { pattern: "(" } }
    assert.deepStrictEqual(details(validateJson(schema, ["a", "b"])), ['$[0]: invalid pattern "("'])
  })
})

describe("validateJson numbers", () => {
  it("checks inclusive minimum and maximum", () => {
    assert.deepStrictEqual(validateJson({ minimum: 1, maximum: 5 }, 1), [])
    assert.deepStrictEqual(details(validateJson({ minimum: 1 }, 0)), [
      "$: value 0 is less than the minimum 1"
    ])
    assert.deepStrictEqual(details(validateJson({ maximum: 5 }, 6)), [
      "$: value 6 is greater than the maximum 5"
    ])
  })

  it("checks numeric exclusive bounds", () => {
    assert.deepStrictEqual(details(validateJson({ exclusiveMinimum: 1 }, 1)), [
      "$: value 1 is not greater than the exclusive minimum 1"
    ])
    assert.deepStrictEqual(details(validateJson({ exclusiveMaximum: 5 }, 5)), [
      "$: value 5 is not less than the exclusive maximum 5"
    ])
    assert.deepStrictEqual(validateJson({ exclusiveMinimum: 1, exclusiveMaximum: 5 }, 3), [])
  })

  it("honours the draft-04 boolean exclusive form", () => {
    assert.deepStrictEqual(details(validateJson({ minimum: 1, exclusiveMinimum: true }, 1)), [
      "$: value 1 is not greater than the exclusive minimum 1"
    ])
    assert.deepStrictEqual(details(validateJson({ maximum: 5, exclusiveMaximum: true }, 5)), [
      "$: value 5 is not less than the exclusive maximum 5"
    ])
  })

  it("checks multipleOf, tolerating float noise", () => {
    assert.deepStrictEqual(validateJson({ multipleOf: 0.1 }, 0.3), [])
    assert.deepStrictEqual(details(validateJson({ multipleOf: 2 }, 7)), [
      "$: value 7 is not a multiple of 2"
    ])
  })
})

describe("validateJson combinators", () => {
  it("surfaces every allOf member's issues", () => {
    const schema = { allOf: [{ minimum: 10 }, { multipleOf: 3 }] }
    assert.deepStrictEqual(details(validateJson(schema, 4)), [
      "$: value 4 is less than the minimum 10",
      "$: value 4 is not a multiple of 3"
    ])
  })

  it("keeps anyOf branch issues internal", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "integer" }] }
    assert.deepStrictEqual(validateJson(schema, 1), [])
    assert.deepStrictEqual(details(validateJson(schema, 1.5)), [
      "$: value does not match any of the 2 anyOf schemas"
    ])
  })

  it("requires exactly one oneOf branch and reports how many matched", () => {
    const schema = { oneOf: [{ type: "number" }, { type: "integer" }] }
    assert.deepStrictEqual(validateJson(schema, 1.5), [])
    assert.deepStrictEqual(details(validateJson(schema, 1)), [
      "$: expected exactly one of the 2 oneOf schemas to match, 2 matched"
    ])
    assert.deepStrictEqual(details(validateJson(schema, "x")), [
      "$: expected exactly one of the 2 oneOf schemas to match, 0 matched"
    ])
  })

  it("rejects a value that matches not", () => {
    assert.deepStrictEqual(details(validateJson({ not: { type: "string" } }, "x")), [
      "$: value matches the not schema"
    ])
    assert.deepStrictEqual(validateJson({ not: { type: "string" } }, 1), [])
  })
})

describe("validateJson $ref", () => {
  const openapi = {
    openapi: "3.0.3",
    components: {
      schemas: {
        Money: { type: "object", required: ["amount"], properties: { amount: { type: "number" } } },
        Order: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            total: { $ref: "#/components/schemas/Money" },
            "a/b": { type: "boolean" }
          }
        }
      }
    }
  }

  it("resolves #/components/schemas pointers against options.root", () => {
    const schema = { $ref: "#/components/schemas/Order" }
    assert.deepStrictEqual(
      validateJson(schema, { id: "o1", total: { amount: 2 } }, { root: openapi }),
      []
    )
    assert.deepStrictEqual(
      details(validateJson(schema, { total: { amount: "2" } }, { root: openapi })),
      ['$: missing required property "id"', "$.total.amount: expected number, found string"]
    )
  })

  it("resolves definitions and $defs against the schema itself by default", () => {
    const draft7 = { definitions: { Id: { type: "integer" } }, items: { $ref: "#/definitions/Id" } }
    assert.deepStrictEqual(details(validateJson(draft7, [1, "x"])), [
      "$[1]: expected integer, found string"
    ])
    const draft2020 = { $defs: { Id: { type: "integer" } }, items: { $ref: "#/$defs/Id" } }
    assert.deepStrictEqual(validateJson(draft2020, [1, 2]), [])
  })

  it("unescapes ~0 and ~1 in pointer tokens", () => {
    const schema = { $ref: "#/components/schemas/Order/properties/a~1b" }
    assert.deepStrictEqual(details(validateJson(schema, 1, { root: openapi })), [
      "$: expected boolean, found number"
    ])
    const tilde = { "x~y": { type: "string" }, $ref: "#/x~0y" }
    assert.deepStrictEqual(details(validateJson(tilde, 1)), ["$: expected string, found number"])
  })

  it("reports a $ref that does not resolve", () => {
    assert.deepStrictEqual(
      details(validateJson({ $ref: "#/components/schemas/Nope" }, 1, { root: openapi })),
      ['$: cannot resolve $ref "#/components/schemas/Nope"']
    )
    assert.deepStrictEqual(details(validateJson({ $ref: "other.json#/X" }, 1)), [
      '$: cannot resolve $ref "other.json#/X"'
    ])
  })

  it("guards against reference cycles with a single nesting issue", () => {
    const cyclic = {
      $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } },
      $ref: "#/$defs/A"
    }
    assert.deepStrictEqual(details(validateJson(cyclic, 1)), ["$: schema nesting too deep"])
  })

  it("follows a recursive schema as deep as the document goes", () => {
    const tree = {
      type: "object",
      properties: { value: { type: "integer" }, children: { type: "array", items: { $ref: "#" } } }
    }
    const document = {
      value: 1,
      children: [{ value: 2, children: [{ value: "3", children: [] }] }]
    }
    assert.deepStrictEqual(details(validateJson(tree, document)), [
      "$.children[0].children[0].value: expected integer, found string"
    ])
  })
})

describe("validateJson ignored keywords", () => {
  it("ignores format and unknown keywords", () => {
    assert.deepStrictEqual(
      validateJson({ type: "string", format: "date-time", "x-internal": true, example: 1 }, "soon"),
      []
    )
  })
})
