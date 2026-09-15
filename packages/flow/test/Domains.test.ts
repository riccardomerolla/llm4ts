import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  DecisionsInvalid,
  DomainFeature,
  Domains,
  checkExactlyOnce,
  clusterPrograms,
  domainsFromProposal,
  domainsInputsHash,
  navigationOrder,
  parseDomains,
  renderDomains
} from "@llm4ts/flow/Domains"
import { SurveyEdge, SurveyGraph, SurveyNode } from "@llm4ts/flow/Survey"

const node = (name: string, path = `src/${name}.jsp`): SurveyNode =>
  SurveyNode.make({ path, name, lines: 10, units: 1 })
const edge = (from: string, to: string, kind: string): SurveyEdge =>
  SurveyEdge.make({ from, to, kind })

/** The demo-bank shape: hero pairs share a form action, fragments are included everywhere. */
const demoGraph = SurveyGraph.make({
  nodes: [
    "login",
    "dashboard",
    "accountOverview",
    "beneficiaryList",
    "beneficiaryEdit",
    "transferStep1",
    "transferStep2",
    "transferConfirm",
    "help",
    "header",
    "nav",
    "footer"
  ]
    .map((name) => node(name))
    .concat([
      node("web", "WEB-INF/web.xml"),
      node("BeneficiaryServlet", "src/BeneficiaryServlet.java")
    ]),
  edges: [
    edge("beneficiaryList", "/beneficiary", "jsp-form-action"),
    edge("beneficiaryEdit", "/beneficiary", "jsp-form-action"),
    edge("transferStep1", "/transfer", "jsp-form-action"),
    edge("transferStep2", "/transfer", "jsp-form-action"),
    edge("transferConfirm", "/transfer", "jsp-form-action"),
    edge("accountOverview", "/accountOverview?fmt=json", "jsp-ajax-target"),
    edge("login", "j_security_check", "jsp-form-action"),
    // Fragments: included by every page; header includes nav. Their own
    // edges (nav posts a logout form) must never merge the pages.
    ...["login", "dashboard", "accountOverview", "beneficiaryList", "help"].flatMap((page) => [
      edge(page, "header", "jsp-include"),
      edge(page, "footer", "jsp-include")
    ]),
    edge("header", "nav", "jsp-include"),
    edge("nav", "/logout", "jsp-form-action"),
    // web.xml fans out to every servlet: a kind the pack does not cluster on.
    edge("web", "BeneficiaryServlet", "servlet-class"),
    edge("web", "TransferServlet", "servlet-class")
  ]
})

const programs = [
  "login",
  "dashboard",
  "accountOverview",
  "beneficiaryList",
  "beneficiaryEdit",
  "transferStep1",
  "transferStep2",
  "transferConfirm",
  "help",
  "header",
  "nav",
  "footer"
]

const rules = { cluster: ["jsp-form-action", "jsp-ajax-target"], context: ["jsp-include"] }

describe("deterministic clustering", () => {
  it("unions pages through shared cluster edges and attaches fragments as context", () => {
    const clusters = clusterPrograms(demoGraph, programs, rules)
    assert.deepStrictEqual(
      clusters.map((cluster) => [cluster.programs, cluster.context, cluster.shell]),
      [
        // Shell clusters first: fragments united by their own include edges.
        [["footer"], [], true],
        [["header", "nav"], [], true],
        // Then by first program name.
        [["accountOverview"], ["footer", "header", "nav"], false],
        [["beneficiaryEdit", "beneficiaryList"], ["footer", "header", "nav"], false],
        [["dashboard"], ["footer", "header", "nav"], false],
        [["help"], ["footer", "header", "nav"], false],
        [["login"], ["footer", "header", "nav"], false],
        [["transferConfirm", "transferStep1", "transferStep2"], [], false]
      ]
    )
  })

  it("a prefix kind such as llm-* matches every refined edge kind", () => {
    const graph = SurveyGraph.make({
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("a", "b", "llm-redirect"), edge("c", "a", "llm-form-action")]
    })
    const clusters = clusterPrograms(graph, ["a", "b", "c"], { cluster: ["llm-*"], context: [] })
    assert.deepStrictEqual(
      clusters.map((cluster) => cluster.programs),
      [["a", "b", "c"]]
    )
  })

  it("with no rules every program is its own cluster", () => {
    const clusters = clusterPrograms(demoGraph, ["a", "b"], { cluster: [], context: [] })
    assert.deepStrictEqual(
      clusters.map((cluster) => cluster.programs),
      [["a"], ["b"]]
    )
  })
})

const feature = (
  id: string,
  name: string,
  programs: ReadonlyArray<string>,
  scenarios: ReadonlyArray<readonly [string, string]>,
  context: ReadonlyArray<string> = []
): DomainFeature =>
  DomainFeature.make({
    id,
    name,
    programs,
    context,
    scenarios: scenarios.map(([program, title]) => ({ program, title, mergedFrom: [] })),
    evidence: `${programs.join(" and ")} belong together`
  })

const surviving = new Map<string, ReadonlySet<string>>([
  ["beneficiaryList", new Set(["List beneficiaries", "Validate IBAN"])],
  ["beneficiaryEdit", new Set(["Save a beneficiary", "Validate IBAN"])],
  ["header", new Set(["Show the customer name"])]
])

describe("domain map", () => {
  it("every surviving scenario lands in exactly one feature", () => {
    const clean = Domains.make({
      features: [
        feature("portal-shell", "Portal shell", ["header"], [["header", "Show the customer name"]]),
        DomainFeature.make({
          id: "beneficiary-maintenance",
          name: "Beneficiary maintenance",
          programs: ["beneficiaryList", "beneficiaryEdit"],
          context: ["header"],
          scenarios: [
            { program: "beneficiaryList", title: "List beneficiaries", mergedFrom: [] },
            { program: "beneficiaryEdit", title: "Save a beneficiary", mergedFrom: [] },
            {
              program: "beneficiaryEdit",
              title: "Validate IBAN",
              mergedFrom: [{ program: "beneficiaryList", title: "Validate IBAN" }]
            }
          ],
          evidence: "both pages post to /beneficiary"
        })
      ],
      inputsHash: "abc",
      openPoints: [],
      approved: false
    })
    assert.deepStrictEqual(checkExactlyOnce(clean, surviving), [])

    const dirty = Domains.make({
      features: [
        feature(
          "a",
          "A",
          ["beneficiaryList"],
          [
            ["beneficiaryList", "List beneficiaries"],
            ["beneficiaryList", "Validate IBAN"]
          ]
        ),
        feature(
          "b",
          "B",
          ["beneficiaryEdit"],
          [
            ["beneficiaryEdit", "Save a beneficiary"],
            ["beneficiaryList", "List beneficiaries"],
            ["beneficiaryEdit", "Export beneficiaries"]
          ]
        )
      ],
      inputsHash: "abc",
      openPoints: [],
      approved: false
    })
    assert.deepStrictEqual(checkExactlyOnce(dirty, surviving), [
      "scenario 'beneficiaryList / List beneficiaries' is assigned twice (a, b)",
      "scenario 'beneficiaryEdit / Export beneficiaries' in feature b is not a surviving scenario of the pack",
      "scenario 'beneficiaryEdit / Validate IBAN' is assigned to no feature",
      "scenario 'header / Show the customer name' is assigned to no feature"
    ])
  })

  it.effect("renders and parses back, guide included", () =>
    Effect.gen(function* () {
      const domains = Domains.make({
        features: [
          DomainFeature.make({
            id: "beneficiary-maintenance",
            name: "Beneficiary maintenance",
            programs: ["beneficiaryList", "beneficiaryEdit"],
            context: ["header", "footer"],
            scenarios: [
              { program: "beneficiaryList", title: "List beneficiaries", mergedFrom: [] },
              {
                program: "beneficiaryEdit",
                title: "Validate IBAN",
                mergedFrom: [{ program: "beneficiaryList", title: "Validate IBAN" }]
              }
            ],
            evidence: "both pages post to /beneficiary and share the beneficiary DTO"
          })
        ],
        inputsHash: "1f2e3d",
        openPoints: [{ number: 1, question: "Fold help into the shell?" }],
        approved: false
      })
      const text = renderDomains(domains)
      assert.include(text, "## How to read this map")
      assert.include(text, "## Feature: Beneficiary maintenance (beneficiary-maintenance)")
      const again = yield* parseDomains(text)
      assert.deepStrictEqual(again.features, domains.features)
      assert.strictEqual(again.inputsHash, "1f2e3d")
      assert.deepStrictEqual(again.openPoints, domains.openPoints)
      assert.strictEqual(again.approved, false)
    })
  )

  it.effect("rejects a feature without programs or a scenario line it cannot read", () =>
    Effect.gen(function* () {
      const failure = yield* parseDomains(
        [
          "# Domain features",
          "",
          "inputs: x",
          "",
          "## Feature: Broken (broken)",
          "",
          "evidence: none",
          "",
          "- not a scenario key",
          ""
        ].join("\n")
      ).pipe(Effect.flip)
      assert.instanceOf(failure, DecisionsInvalid)
      assert.deepStrictEqual(failure.violations, [
        "line 9: scenario lines read `- <program> / <title>`, got: not a scenario key",
        "feature 'broken' lists no programs"
      ])
    })
  )

  it("builds the map from a model proposal over the clusters", () => {
    const domains = domainsFromProposal(
      {
        features: [
          {
            id: "beneficiary-maintenance",
            name: "Beneficiary maintenance",
            programs: ["beneficiaryList", "beneficiaryEdit"],
            scenarios: [
              { program: "beneficiaryList", title: "List beneficiaries" },
              {
                program: "beneficiaryEdit",
                title: "Validate IBAN",
                mergedFrom: [{ program: "beneficiaryList", title: "Validate IBAN" }]
              },
              { program: "beneficiaryEdit", title: "Save a beneficiary" }
            ],
            evidence: "shared form action"
          }
        ],
        openPoints: ["Fold help into the shell?"]
      },
      clusterPrograms(demoGraph, programs, rules),
      "hash"
    )
    assert.deepStrictEqual(domains.features[0]?.context, ["footer", "header", "nav"])
    assert.deepStrictEqual(
      domains.openPoints.map((point) => [point.number, point.question]),
      [[1, "Fold help into the shell?"]]
    )
    assert.strictEqual(domains.inputsHash, "hash")
  })

  it("the inputs hash is stable over order and changes with content", () => {
    const one = domainsInputsHash({ b: "spec b", a: "spec a" }, "decisions")
    const two = domainsInputsHash({ a: "spec a", b: "spec b" }, "decisions")
    const three = domainsInputsHash({ a: "spec a", b: "spec b!" }, "decisions")
    assert.strictEqual(one, two)
    assert.notStrictEqual(one, three)
  })
})

describe("navigation order inside a feature", () => {
  it("puts unreached pages first and follows the feature's own edges", () => {
    const graph = SurveyGraph.make({
      nodes: ["transferStep1", "transferStep2", "transferConfirm", "help"].map((n) => node(n)),
      edges: [
        edge("transferStep1", "/transfer", "jsp-form-action"),
        edge("transferStep2", "/transfer", "jsp-form-action"),
        edge("transferStep1", "transferStep2", "llm-redirect"),
        edge("transferStep2", "transferConfirm", "llm-redirect"),
        edge("transferConfirm", "transferStep1", "llm-link")
      ]
    })
    const wizard = DomainFeature.make({
      id: "wire-transfer",
      name: "Wire transfer",
      programs: ["transferConfirm", "transferStep2", "transferStep1"],
      context: [],
      scenarios: [],
      evidence: ""
    })
    assert.deepStrictEqual(
      navigationOrder(wizard, graph, { cluster: ["jsp-form-action", "llm-redirect"], context: [] }),
      ["transferStep1", "transferStep2", "transferConfirm"]
    )
    // A cycle over every page: the feature's own order decides.
    assert.deepStrictEqual(
      navigationOrder(wizard, graph, { cluster: ["llm-*", "jsp-form-action"], context: [] }),
      ["transferConfirm", "transferStep2", "transferStep1"]
    )
  })
})
