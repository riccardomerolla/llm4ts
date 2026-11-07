import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { ToolReport, ToolSpec } from "@llm4ts/flow/tools/Tool"

const toolFile = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "xml-validate.ts")

const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:bank" xmlns="urn:bank" elementFormDefault="qualified">
  <xs:element name="Transfer">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="from" type="xs:string"/>
        <xs:element name="amount" type="Amount"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:simpleType name="Amount">
    <xs:restriction base="xs:decimal"><xs:minInclusive value="0"/></xs:restriction>
  </xs:simpleType>
</xs:schema>
`

/** Runs the kit tool the way `llm4ts tool` does: a Node child speaking the ToolMain protocol. */
const run = (args: ReadonlyArray<string>, stdin: string | undefined) =>
  spawnSync(process.execPath, ["--experimental-strip-types", toolFile, ...args], {
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  })

describe("xml-validate kit tool", () => {
  it("describes itself on --describe", () => {
    const result = run(["--describe"], undefined)
    assert.strictEqual(result.status, 0, result.stderr)
    const spec = Schema.decodeUnknownSync(Schema.fromJsonString(ToolSpec))(result.stdout.trim())
    assert.strictEqual(spec.name, "xml-validate")
    assert.isTrue(spec.args.schema?.required)
    assert.isTrue(spec.args.document?.required)
  })

  it("validates a document against the schema and reports facet and structure issues", () => {
    const base = mkdtempSync(join(tmpdir(), "llm4ts-xml-"))
    try {
      writeFileSync(join(base, "transfer.xsd"), xsd)
      writeFileSync(
        join(base, "good.xml"),
        '<Transfer xmlns="urn:bank"><from>IT60X</from><amount>10.50</amount></Transfer>'
      )
      writeFileSync(
        join(base, "bad.xml"),
        '<Transfer xmlns="urn:bank"><amount>-3</amount><extra>x</extra></Transfer>'
      )
      const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ToolReport))
      const good = run(
        [],
        JSON.stringify({ schema: join(base, "transfer.xsd"), document: join(base, "good.xml") })
      )
      assert.strictEqual(good.status, 0, good.stdout + good.stderr)
      assert.isTrue(decode(good.stdout.trim()).ok)
      const bad = run(
        [],
        JSON.stringify({ schema: join(base, "transfer.xsd"), document: join(base, "bad.xml") })
      )
      assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr)
      const report = decode(bad.stdout.trim())
      assert.isFalse(report.ok)
      const text = report.issues.map((issue) => `${issue.path}: ${issue.detail}`).join("\n")
      assert.match(text, /from/)
      assert.match(text, /amount/)
      assert.match(text, /extra/)
      const unknown = run(
        [],
        JSON.stringify({
          schema: join(base, "transfer.xsd"),
          document: join(base, "good.xml"),
          root: "Nope"
        })
      )
      assert.strictEqual(unknown.status, 2)
      assert.match(unknown.stdout, /declares no global element 'Nope'; known: Transfer/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
