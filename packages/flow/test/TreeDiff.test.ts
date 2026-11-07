import { assert, describe, it } from "@effect/vitest"
import { canonicalJson, diffJson } from "@llm4ts/flow/tools/TreeDiff"
import type { DiffIssue, DiffOrdering } from "@llm4ts/flow/tools/TreeDiff"

const lines = (issues: ReadonlyArray<DiffIssue>): ReadonlyArray<string> =>
  issues.map((issue) => `${issue.kind} ${issue.path}: ${issue.detail}`)

const diff = (
  expected: unknown,
  actual: unknown,
  ordering: DiffOrdering = "ordered",
  ignore: ReadonlyArray<string> = []
): ReadonlyArray<string> => lines(diffJson(expected, actual, { ordering, ignore }))

describe("canonicalJson", () => {
  it("sorts keys at every level and drops whitespace", () => {
    assert.strictEqual(
      canonicalJson({ b: [{ z: 1, a: 2 }], a: "x" }),
      '{"a":"x","b":[{"a":2,"z":1}]}'
    )
  })

  it("normalises numbers by value", () => {
    assert.strictEqual(canonicalJson(-0), "0")
    assert.strictEqual(canonicalJson(1.0), "1")
    assert.strictEqual(canonicalJson({ a: undefined, b: null }), '{"b":null}')
  })
})

describe("diffJson primitives and objects", () => {
  it("reports nothing for equal values", () => {
    assert.deepStrictEqual(diff({ a: 1, b: [1, "x"], c: null }, { c: null, b: [1, "x"], a: 1 }), [])
    assert.deepStrictEqual(diff(0, -0), [])
    assert.deepStrictEqual(diff(1, 1.0), [])
  })

  it("reports a changed primitive with both renderings", () => {
    assert.deepStrictEqual(diff(1, 2), ["changed $: expected 1, found 2"])
    assert.deepStrictEqual(diff({ a: "x" }, { a: "y" }), ['changed $.a: expected "x", found "y"'])
    assert.deepStrictEqual(diff(true, false), ["changed $: expected true, found false"])
  })

  it("reports a type difference by JSON type name and stops there", () => {
    assert.deepStrictEqual(diff({ a: {} }, { a: [] }), ["type $.a: expected object, found array"])
    assert.deepStrictEqual(diff(null, 0), ["type $: expected null, found number"])
    assert.deepStrictEqual(diff({ a: { b: 1 } }, { a: 1 }), [
      "type $.a: expected object, found number"
    ])
  })

  it("reports missing and unexpected properties", () => {
    assert.deepStrictEqual(diff({ a: 1, b: 2 }, { a: 1, c: 3 }), [
      'missing $.b: missing property "b"',
      'unexpected $.c: unexpected property "c"'
    ])
  })

  it("lists expected keys first, then the extras of actual, recursing deep", () => {
    assert.deepStrictEqual(diff({ x: { y: { z: 1 } }, w: 1 }, { w: 2, x: { y: { z: 2, q: 0 } } }), [
      "changed $.x.y.z: expected 1, found 2",
      'unexpected $.x.y.q: unexpected property "q"',
      "changed $.w: expected 1, found 2"
    ])
  })

  it("caps long renderings at 80 characters", () => {
    const long = "a".repeat(200)
    const [issue] = diffJson(long, "b", { ordering: "ordered", ignore: [] })
    assert.ok(issue !== undefined)
    assert.ok(issue.detail.startsWith('expected "aaaa'))
    assert.ok(issue.detail.includes('…, found "b"'))
    assert.ok(issue.detail.length < 120)
  })

  it("quotes property names that are not identifiers", () => {
    assert.deepStrictEqual(diff({ "content-type": 1 }, { "content-type": 2 }), [
      'changed $["content-type"]: expected 1, found 2'
    ])
  })
})

describe("diffJson ordered arrays", () => {
  it("compares by position and recurses into elements", () => {
    assert.deepStrictEqual(diff([{ p: 1 }, { p: 2 }], [{ p: 1 }, { p: 3 }]), [
      "changed $[1].p: expected 2, found 3"
    ])
  })

  it("reports a shorter actual as missing items at their index", () => {
    assert.deepStrictEqual(diff({ items: [1, 2, 3] }, { items: [1] }), [
      "missing $.items[1]: missing item 2 at index 1",
      "missing $.items[2]: missing item 3 at index 2"
    ])
  })

  it("reports a longer actual as unexpected items at their index", () => {
    assert.deepStrictEqual(diff([1], [1, { b: 2 }]), [
      'unexpected $[1]: unexpected item {"b":2} at index 1'
    ])
  })

  it("sees a reordering as changes", () => {
    assert.deepStrictEqual(diff([1, 2], [2, 1]), [
      "changed $[0]: expected 1, found 2",
      "changed $[1]: expected 2, found 1"
    ])
  })
})

describe("diffJson per-key arrays", () => {
  it("matches object elements by the first key field present", () => {
    const expected = [
      { id: 1, v: "a" },
      { id: 2, v: "b" }
    ]
    const actual = [
      { id: 2, v: "b" },
      { id: 1, v: "a" }
    ]
    assert.deepStrictEqual(diff(expected, actual, "per-key"), [])
    assert.deepStrictEqual(
      diff(
        expected,
        [
          { id: 2, v: "B" },
          { id: 1, v: "a" }
        ],
        "per-key"
      ),
      ['changed $[id=2].v: expected "b", found "B"']
    )
  })

  it("reports missing and unexpected elements by key", () => {
    assert.deepStrictEqual(
      diff({ items: [{ id: 42 }, { id: 7 }] }, { items: [{ id: 7 }, { id: "x9" }] }, "per-key"),
      [
        "missing $.items[id=42]: missing item with id=42",
        "unexpected $.items[id=x9]: unexpected item with id=x9"
      ]
    )
  })

  it("prefers the earliest key field and honours custom keyFields", () => {
    const expected = [{ key: "k", name: "n", v: 1 }]
    assert.deepStrictEqual(
      lines(
        diffJson(expected, [{ key: "k", name: "m", v: 1 }], { ordering: "per-key", ignore: [] })
      ),
      ['changed $[key=k].name: expected "n", found "m"']
    )
    assert.deepStrictEqual(
      lines(
        diffJson(expected, [{ key: "j", name: "n", v: 1 }], {
          ordering: "per-key",
          ignore: [],
          keyFields: ["name"]
        })
      ),
      ['changed $[name=n].key: expected "k", found "j"']
    )
  })

  it("falls back to position for elements without any key field", () => {
    assert.deepStrictEqual(
      diff([{ v: 1 }, { id: 1, v: 2 }], [{ v: 9 }, { id: 1, v: 2 }], "per-key"),
      ["changed $[0].v: expected 1, found 9"]
    )
    assert.deepStrictEqual(diff([{ v: 1 }, "x"], [{ v: 1 }], "per-key"), [
      'missing $[1]: missing item "x" at index 1'
    ])
    assert.deepStrictEqual(diff([{ id: 1 }], [{ id: 1 }, 5], "per-key"), [
      "unexpected $[1]: unexpected item 5 at index 1"
    ])
  })

  it("does not pair a keyless expected element with a keyed actual one at the same index", () => {
    assert.deepStrictEqual(diff([{ v: 1 }], [{ id: 1, v: 1 }], "per-key"), [
      'missing $[0]: missing item {"v":1} at index 0',
      "unexpected $[id=1]: unexpected item with id=1"
    ])
  })

  it("renders non-plain key values as JSON", () => {
    assert.deepStrictEqual(diff([{ id: "a b" }], [], "per-key"), [
      'missing $[id="a b"]: missing item with id="a b"'
    ])
  })
})

describe("diffJson unordered arrays", () => {
  it("matches elements as a multiset of canonical JSON", () => {
    assert.deepStrictEqual(diff([{ a: 1, b: 2 }, 3, 3], [3, { b: 2, a: 1 }, 3], "unordered"), [])
  })

  it("reports leftovers as missing then unexpected, with their own indexes", () => {
    assert.deepStrictEqual(diff({ items: [1, 2, 2] }, { items: [2, 1, 5] }, "unordered"), [
      "missing $.items[2]: missing item 2",
      "unexpected $.items[2]: unexpected item 5"
    ])
  })

  it("treats a near-identical element as a missing and unexpected pair", () => {
    assert.deepStrictEqual(diff([{ id: 1, v: 1 }], [{ id: 1, v: 2 }], "unordered"), [
      'missing $[0]: missing item {"id":1,"v":1}',
      'unexpected $[0]: unexpected item {"id":1,"v":2}'
    ])
  })
})

describe("diffJson ignore", () => {
  it("skips an ignored path on both sides", () => {
    const ignore = ["meta.requestId"]
    assert.deepStrictEqual(
      diff({ meta: { requestId: 1 } }, { meta: { requestId: 2 } }, "ordered", ignore),
      []
    )
    assert.deepStrictEqual(diff({ meta: { requestId: 1 } }, { meta: {} }, "ordered", ignore), [])
    assert.deepStrictEqual(diff({ meta: {} }, { meta: { requestId: 2 } }, "ordered", ignore), [])
  })

  it("matches a * wildcard against any one segment, including array indexes", () => {
    const expected = {
      items: [
        { updatedAt: 1, v: 1 },
        { updatedAt: 1, v: 2 }
      ]
    }
    const actual = { items: [{ updatedAt: 9, v: 1 }, { v: 2 }] }
    assert.deepStrictEqual(diff(expected, actual, "ordered", ["items.*.updatedAt"]), [])
    assert.deepStrictEqual(diff(expected, actual, "ordered", ["items.*"]), [])
    assert.deepStrictEqual(diff(expected, actual, "ordered", ["*.*.updatedAt"]), [])
    assert.deepStrictEqual(diff(expected, actual, "ordered", ["items.0.updatedAt"]), [
      'missing $.items[1].updatedAt: missing property "updatedAt"'
    ])
  })

  it("does not match a wildcard across more segments than it names", () => {
    assert.deepStrictEqual(
      diff({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, "ordered", ["a.*"]),
      []
    )
    assert.deepStrictEqual(
      diff({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, "ordered", ["*.c"]),
      ["changed $.a.b.c: expected 1, found 2"]
    )
  })

  it("strips ignored paths before unordered matching", () => {
    const expected = [
      { id: 1, updatedAt: 1 },
      { id: 2, updatedAt: 1 }
    ]
    const actual = [
      { id: 2, updatedAt: 5 },
      { id: 1, updatedAt: 5 }
    ]
    assert.deepStrictEqual(diff(expected, actual, "unordered", ["*.updatedAt"]), [])
    assert.strictEqual(diff(expected, actual, "unordered").length, 4)
  })

  it("matches per-key identity segments by value or field=value", () => {
    const expected = [{ id: 7, v: 1 }]
    const actual = [{ id: 7, v: 2 }]
    assert.deepStrictEqual(diff(expected, actual, "per-key", ["7.v"]), [])
    assert.deepStrictEqual(diff(expected, actual, "per-key", ["id=7.v"]), [])
    assert.deepStrictEqual(diff(expected, actual, "per-key", ["8.v"]), [
      "changed $[id=7].v: expected 1, found 2"
    ])
  })
})
