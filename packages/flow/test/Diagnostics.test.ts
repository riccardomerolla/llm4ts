import { assert, describe, it } from "@effect/vitest"
import { groupDiagnostics, parseDiagnostics, renderDiagnostics } from "@llm4ts/flow/Diagnostics"

describe("diagnostics (ADR 0028)", () => {
  it("reads json lines, skipping noise, and groups by unit or directory", () => {
    const text = [
      "building...",
      '{"file":"src/a/x.ts","line":3,"message":"TS2322: no"}',
      '{"file":"src/b/y.ts","message":"TS1005: nope","unit":"pkg-b"}',
      "not json",
      '{"file":"src/a/z.ts","line":9,"message":"TS2345: nah"}'
    ].join("\n")
    const diagnostics = parseDiagnostics(text)
    assert.strictEqual(diagnostics.length, 3)
    const groups = groupDiagnostics(diagnostics)
    assert.deepStrictEqual(
      groups.map((group) => [group.unit, group.diagnostics.length]),
      [
        ["pkg-b", 1],
        ["src/a", 2]
      ]
    )
    assert.include(renderDiagnostics(groups[1]?.diagnostics ?? []), "- src/a/x.ts:3: TS2322: no")
  })

  it("reads cargo's json messages: errors only, the crate as the unit", () => {
    const text = [
      JSON.stringify({ reason: "compiler-artifact", target: { name: "bun_core" } }),
      JSON.stringify({
        reason: "compiler-message",
        target: { name: "bun_core" },
        message: {
          level: "warning",
          message: "unused",
          spans: [{ file_name: "src/a.rs", line_start: 1, is_primary: true }]
        }
      }),
      JSON.stringify({
        reason: "compiler-message",
        target: { name: "bun_core" },
        message: {
          level: "error",
          message: "mismatched types",
          spans: [
            { file_name: "src/other.rs", line_start: 1, is_primary: false },
            { file_name: "src/a.rs", line_start: 42, is_primary: true }
          ]
        }
      })
    ].join("\n")
    const diagnostics = parseDiagnostics(text, "cargo")
    assert.deepStrictEqual(
      diagnostics.map((d) => [d.unit, d.file, d.line, d.message]),
      [["bun_core", "src/a.rs", 42, "mismatched types"]]
    )
  })
})

describe("tsc diagnostics", () => {
  it("reads tsc --pretty false lines, the top folders as the unit", () => {
    const text = [
      "packages/flow/src/A.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/B.ts(3,1): error TS2304: Cannot find name 'x'.",
      "Found 2 errors."
    ].join("\n")
    const diagnostics = parseDiagnostics(text, "tsc")
    assert.deepStrictEqual(
      diagnostics.map((d) => [d.unit, d.file, d.line, d.message.slice(0, 6)]),
      [
        ["packages/flow", "packages/flow/src/A.ts", 12, "TS2322"],
        ["src", "src/B.ts", 3, "TS2304"]
      ]
    )
  })
})

describe("javac diagnostics", () => {
  it("reads javac and Maven error lines, the Maven module as the unit", () => {
    const text = [
      "[INFO] Compiling 12 source files",
      "[ERROR] /work/bank/core/src/main/java/com/bank/Ledger.java:[12,5] cannot find symbol",
      "[ERROR]   symbol: class Money",
      "/work/bank/web/src/main/java/com/bank/web/Home.java:40: error: incompatible types: String cannot be converted to int",
      "Note: Some input files use unchecked operations.",
      "2 errors"
    ].join("\n")
    const diagnostics = parseDiagnostics(text, "javac")
    assert.deepStrictEqual(
      diagnostics.map((diagnostic) => [diagnostic.file, diagnostic.line, diagnostic.unit]),
      [
        ["/work/bank/core/src/main/java/com/bank/Ledger.java", 12, "/work/bank/core"],
        ["/work/bank/web/src/main/java/com/bank/web/Home.java", 40, "/work/bank/web"]
      ]
    )
    assert.strictEqual(diagnostics[0]?.message, "cannot find symbol")
    assert.deepStrictEqual(
      groupDiagnostics(diagnostics).map((group) => group.unit),
      ["/work/bank/core", "/work/bank/web"]
    )
    // A file outside any src/ folder falls back to its directory.
    assert.strictEqual(parseDiagnostics("Tool.java:3: error: boom", "javac")[0]?.unit, ".")
  })
})
