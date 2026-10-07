import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  edgeKindsOf,
  graphRulesHash,
  matchUrl,
  normalizeUrl,
  parseGraphRules
} from "@llm4ts/flow/GraphRules"
import { CoverageRule } from "@llm4ts/flow/SpecChecks"

const sections = (markdown: string): ReadonlyArray<string> =>
  markdown
    .trim()
    .split(/^(?=## )/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)

const manifest = `## Node: servlet-mapping
files: .*web\\.xml
pattern: <servlet-mapping>\\s*<servlet-name>(?<name>[^<]+)</servlet-name>\\s*<url-pattern>(?<url>[^<]+)</url-pattern>
descriptor: yes

## Node: ajax-call
files: .*\\.(js|jsp)
pattern: url:\\s*['"](?<name>[^'"]+)['"]
attrs: url=name

## Edge: performs
files: .*\\.cbl
pattern: PERFORM +(?<to>\\d{4}-[A-Z0-9-]+)(?: +THRU +(?<thru>\\d{4}-[A-Z0-9-]+))?
from: cobol-paragraph
to: cobol-paragraph

## Node: cobol-paragraph
files: .*\\.cbl
pattern: ^ {7}(?<name>\\d{4}-[A-Z0-9-]+)\\.

## Join: jsp-ajax-target
from: ajax-call.url
to: servlet-mapping.url
match: url

## Probe: save-invoice
from: file:fattura
to: file:InvoiceServlet

## Graph
- worklist-max: 50
- batch-size: 5
`

describe("graph rules", () => {
  it.effect("parses node, edge, join, probe and graph sections and folds survey rules in", () =>
    Effect.gen(function* () {
      const survey = [
        CoverageRule.make({ name: "calls", files: ".*\\.cbl", unit: "CALL '([A-Z0-9]+)'" })
      ]
      const rules = yield* parseGraphRules(sections(manifest), survey)
      assert.deepStrictEqual(
        rules.nodes.map((rule) => rule.kind),
        ["servlet-mapping", "ajax-call", "cobol-paragraph"]
      )
      assert.strictEqual(rules.nodes[0]?.descriptor, true)
      assert.deepStrictEqual(rules.nodes[1]?.attrs, { url: "name" })
      assert.deepStrictEqual(
        rules.edges.map((rule) => `${rule.kind}:${rule.fromKind}>${rule.toKind}`),
        ["calls:file>file", "performs:cobol-paragraph>cobol-paragraph"]
      )
      assert.strictEqual(rules.edges[0]?.pattern, "CALL '(?<to>[A-Z0-9]+)'")
      assert.deepStrictEqual(
        { ...rules.joins[0] },
        {
          kind: "jsp-ajax-target",
          fromKind: "ajax-call",
          fromAttr: "url",
          toKind: "servlet-mapping",
          toAttr: "url",
          match: "url",
          scope: "app"
        }
      )
      assert.deepStrictEqual(
        rules.probes.map((probe) => ({ ...probe })),
        [{ name: "save-invoice", from: "file:fattura", to: "file:InvoiceServlet" }]
      )
      assert.strictEqual(rules.worklistMax, 50)
      assert.strictEqual(rules.batchSize, 5)
      assert.deepStrictEqual([...edgeKindsOf(rules)].sort(), [
        "calls",
        "jsp-ajax-target",
        "performs"
      ])
      assert.strictEqual(
        graphRulesHash(rules),
        graphRulesHash(yield* parseGraphRules(sections(manifest), survey))
      )
    })
  )

  it.effect(
    "rejects a node pattern without a name group, an edge without a to group, and a join on an undeclared kind",
    () =>
      Effect.gen(function* () {
        const bad = (body: string) =>
          parseGraphRules(sections(body), []).pipe(
            Effect.flip,
            Effect.map((error) => error.message)
          )
        assert.include(yield* bad("## Node: x\nfiles: .*\npattern: (?<url>a)\n"), "(?<name>")
        assert.include(yield* bad("## Edge: x\nfiles: .*\npattern: a\n"), "(?<to>")
        assert.include(yield* bad("## Join: x\nfrom: ghost.url\nto: ghost.url\n"), "ghost")
        assert.include(
          yield* bad("## Node: x\nfiles: .*\npattern: (?<name>[\n"),
          "not a valid regex"
        )
      })
  )

  it("normalises and matches URLs in servlet-spec order", () => {
    assert.strictEqual(normalizeUrl("${ctx}/salvaFattura?id=1"), "/salvaFattura")
    assert.strictEqual(normalizeUrl("<%=request.getContextPath()%>/a/b/"), "/a/b")
    assert.strictEqual(normalizeUrl("https://host:8080/app/x#frag"), "/app/x")
    assert.strictEqual(normalizeUrl("salvaFattura.do"), "/salvaFattura.do")
    assert.strictEqual(normalizeUrl("/"), "/")
    assert.strictEqual(matchUrl("/salvaFattura", "/salvaFattura"), "exact")
    assert.strictEqual(matchUrl("/api/report/monthly", "/api/*"), "prefix")
    assert.strictEqual(matchUrl("/salvaFattura.do", "*.do"), "extension")
    assert.strictEqual(matchUrl("/other", "/api/*"), undefined)
  })
})
