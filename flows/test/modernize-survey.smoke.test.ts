import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { SurveyGraph } from "@llm4ts/flow/Survey"

const flowsRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * End-to-end smoke for the modernization pipeline with the MODEL mocked and
 * nothing else. The flow, runner, pack loader, workspace, and git are all
 * real; only the `claude` binary on PATH is replaced by a stub that speaks
 * the CLI's `--output-format stream-json` protocol and answers from a canned
 * script. That keeps the test hermetic — no network, no credentials, no
 * installed coding agent — while still exercising the wiring a live run uses.
 *
 * This is the pre-release check that a modernization flow starts, reads its
 * pack, drives its stages in order, writes its artifacts, and commits.
 */
const stubClaude = `#!/usr/bin/env node
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8")
  // Every prompt is recorded next to the stub so a test can assert on what
  // the flow actually sent — the pack-owned wording, above all.
  require("node:fs").appendFileSync(
    require("node:path").join(__dirname, "prompts.log"),
    prompt + "\\n=== END PROMPT ===\\n"
  )
  // Only the refine prompt lists units on one line; the triage prompt carries
  // the inventory table instead — so the estate is recognised by a unit name.
  const cobol = prompt.includes("ACCTXFR")
  // The survey makes exactly two structured calls; both are answered from the
  // prompt's own vocabulary so the stub never has to guess an order. The
  // COBOL estate gets the canned answers below; any other estate gets a
  // derived one — every unit rewritten in a single wave.
  const reply = prompt.includes("refining the dependency graph")
    ? cobol
      ? {
          edges: [
            {
              from: "RUNJOB",
              to: "ACCTXFR",
              kind: "dynamic-call",
              evidence: "RUNJOB.JCL:2 //STEP1 EXEC PGM=&PGM  (PGM set to ACCTXFR)"
            }
          ],
          notes: ["CEE3ABD is a system service, not an estate unit"]
        }
      : { edges: [], notes: [] }
    : cobol
      ? {
          triage: [
            { name: "ACCTXFR", disposition: "rewrite", rationale: "Live transfer logic, 2 callers." },
            { name: "FEECALC", disposition: "rewrite", rationale: "Fee rules used by ACCTXFR." },
            { name: "RUNJOB", disposition: "wrap", rationale: "Scheduler entry point; keep for now." }
          ],
          waves: [
            {
              name: "wave-1",
              programs: ["FEECALC"],
              rationale: "Leaf unit with no outgoing estate dependencies."
            },
            {
              name: "wave-2",
              programs: ["ACCTXFR"],
              rationale: "Depends on FEECALC, which wave-1 migrates."
            }
          ],
          notes: []
        }
      : {
          triage: [...new Set([...prompt.matchAll(/^\\| ([A-Za-z0-9_-]+) \\| /gm)].map((m) => m[1]))]
            .filter((name) => name !== "Unit" && name !== "----")
            .map((name) => ({ name, disposition: "rewrite", rationale: "Live page." })),
          waves: [{ name: "wave-1", programs: ["login"], rationale: "Read-only screen first." }],
          notes: []
        }
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
  emit({ type: "system", subtype: "init", model: "stub-claude-1" })
  emit({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(reply) }] } })
  emit({ type: "result", usage: { input_tokens: 120, output_tokens: 45 } })
})
`

const cobolAcctxfr = [
  "       IDENTIFICATION DIVISION.",
  "       PROGRAM-ID. ACCTXFR.",
  "       PROCEDURE DIVISION.",
  "       0100-VALIDATE-INPUT.",
  "           CALL 'FEECALC'.",
  "       0200-POST-LEDGER.",
  "           EXIT."
].join("\n")

const cobolFeecalc = [
  "       IDENTIFICATION DIVISION.",
  "       PROGRAM-ID. FEECALC.",
  "       DATA DIVISION.",
  "       01  WS-AMOUNT   PIC S9(7)V99 COMP-3.",
  "       PROCEDURE DIVISION.",
  "       0100-COMPUTE-FEE.",
  "           EXIT."
].join("\n")

/**
 * The step names its program through a symbolic parameter, so the pack's
 * `EXEC +PGM=([A-Z0-9]+)` rule cannot see it — precisely the blind spot the
 * graph-refine pass exists to close.
 */
const jclRunjob = [
  "//RUNJOB   JOB",
  "//         SET PGM=ACCTXFR",
  "//STEP1    EXEC PGM=&PGM",
  "//SYSIN    DD *"
].join("\n")

// Legacy estates carry multi-megabyte generated copybooks; the survey reads
// sources under legacySourceWorkspaceLimits, so a ~1.6 MB file (over the
// 1 MiB default cap that used to fail the whole inventory) must survive.
const cobolBigcopy = "       05  FILLER              PIC X(40).\n".repeat(38_000)

interface Estate {
  readonly root: string
  readonly binDir: string
}

const makeEstate = (): Estate => {
  const root = mkdtempSync(join(tmpdir(), "llm4ts-survey-smoke-"))
  const estate = join(root, "estate")
  const binDir = join(root, "bin")
  mkdirSync(join(estate, "cobol"), { recursive: true })
  mkdirSync(join(estate, "jcl"), { recursive: true })
  mkdirSync(binDir, { recursive: true })

  writeFileSync(join(estate, "cobol", "ACCTXFR.cbl"), `${cobolAcctxfr}\n`)
  writeFileSync(join(estate, "cobol", "BIGCOPY.cpy"), cobolBigcopy)
  writeFileSync(join(estate, "cobol", "FEECALC.cbl"), `${cobolFeecalc}\n`)
  writeFileSync(join(estate, "jcl", "RUNJOB.JCL"), `${jclRunjob}\n`)

  const stubPath = join(binDir, "claude")
  writeFileSync(stubPath, stubClaude)
  chmodSync(stubPath, 0o755)

  const git = (...args: ReadonlyArray<string>): void => {
    execFileSync("git", [...args], { cwd: estate, stdio: "ignore" })
  }
  git("init", "-q", "-b", "main")
  git("config", "user.email", "smoke@llm4ts.test")
  git("config", "user.name", "llm4ts smoke")
  git("add", "-A")
  git("commit", "-qm", "estate baseline")

  return { root, binDir }
}

/**
 * A small J2EE estate shaped like the demo-bank fixture: a page including two
 * layout fragments (one by bare name, one by absolute path), a servlet wired
 * through web.xml, and — the part that used to kill the survey — a build
 * output tree and a git object store with more files than the discovery cap.
 */
const makeJ2eeEstate = (): Estate => {
  const root = mkdtempSync(join(tmpdir(), "llm4ts-survey-smoke-j2ee-"))
  const estate = join(root, "estate")
  const binDir = join(root, "bin")
  const webapp = join(estate, "src", "main", "webapp")
  mkdirSync(join(webapp, "WEB-INF", "fragments"), { recursive: true })
  mkdirSync(join(estate, "src", "main", "java", "com", "bank", "web"), { recursive: true })
  mkdirSync(join(estate, "target", "classes"), { recursive: true })
  mkdirSync(binDir, { recursive: true })

  writeFileSync(
    join(webapp, "login.jsp"),
    [
      '<jsp:include page="header.jsp" />',
      '<form action="/login" method="post"><input name="user" /></form>',
      '<jsp:include page="/WEB-INF/fragments/footer.jsp" />'
    ].join("\n") + "\n"
  )
  writeFileSync(join(webapp, "header.jsp"), "<h1>Demo Bank</h1>\n")
  writeFileSync(join(webapp, "WEB-INF", "fragments", "footer.jsp"), "<footer/>\n")
  writeFileSync(
    join(webapp, "WEB-INF", "web.xml"),
    [
      "<web-app>",
      "  <servlet><servlet-name>login</servlet-name>",
      "    <servlet-class>com.bank.web.LoginServlet</servlet-class></servlet>",
      "  <servlet-mapping><servlet-name>login</servlet-name><url-pattern>/login</url-pattern></servlet-mapping>",
      "</web-app>"
    ].join("\n") + "\n"
  )
  writeFileSync(
    join(estate, "src", "main", "java", "com", "bank", "web", "LoginServlet.java"),
    "package com.bank.web;\npublic class LoginServlet {}\n"
  )
  // 1 200 compiled classes: over the 1 000-file cap on their own, and they
  // match nothing in the pack's sources regex anyway. Two of them are .xml so
  // the pruning, not just the regex, is what keeps them out of the inventory.
  for (let index = 0; index < 1_200; index += 1) {
    writeFileSync(join(estate, "target", "classes", `Gen${index}.class`), "CAFEBABE")
  }
  writeFileSync(join(estate, "target", "classes", "web.xml"), "<web-app/>\n")
  writeFileSync(join(estate, "target", "classes", "login.jsp"), "<stale/>\n")

  const stubPath = join(binDir, "claude")
  writeFileSync(stubPath, stubClaude)
  chmodSync(stubPath, 0o755)

  const git = (...args: ReadonlyArray<string>): void => {
    execFileSync("git", [...args], { cwd: estate, stdio: "ignore" })
  }
  git("init", "-q", "-b", "main")
  git("config", "user.email", "smoke@llm4ts.test")
  git("config", "user.name", "llm4ts smoke")
  git("add", "-A")
  git("commit", "-qm", "estate baseline")

  return { root, binDir }
}

const runSurvey = (estate: Estate, cwd: string = flowsRoot, pack = "packs/cobol-springboot") =>
  spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(flowsRoot, "modernize-survey.ts"),
      "--repo",
      join(estate.root, "estate")
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${estate.binDir}:${process.env.PATH ?? ""}`,
        LLM4TS_PACK: pack,
        // The stub answers as `claude`, which is also coderFromEnv's default;
        // set it explicitly so the test does not depend on that default.
        LLM4TS_CODER: "claude",
        LLM4TS_VERBOSITY: "quiet"
      }
    }
  )

describe("modernize-survey end to end (model stubbed)", () => {
  it("surveys an estate, refines its graph, and writes an unapproved wave plan", () => {
    const estate = makeEstate()
    try {
      const result = runSurvey(estate)
      assert.strictEqual(
        result.status,
        0,
        `survey exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
      )

      const modDir = join(estate.root, "estate", "docs", "modernization")
      const read = (name: string): string => readFileSync(join(modDir, name), "utf8")

      // 1. The deterministic graph found every unit and the regex-derived
      //    edges. Decoding with the real schema also proves the flow wrote a
      //    graph.json a later phase can read back.
      const graph = Schema.decodeUnknownSync(SurveyGraph)(JSON.parse(read("graph.json")))
      assert.deepStrictEqual(graph.nodes.map((node) => node.name).sort(), [
        "ACCTXFR",
        "BIGCOPY",
        "FEECALC",
        "RUNJOB"
      ])
      // CALL 'FEECALC' in ACCTXFR.cbl is a regex-derived edge.
      assert.deepStrictEqual(
        graph.edges
          .filter((edge) => edge.kind === "calls")
          .map((edge) => `${edge.from}->${edge.to}`),
        ["ACCTXFR->FEECALC"]
      )

      // 2. The LLM refinement was merged and tagged so it stays distinguishable
      //    from the regex-derived edges.
      assert.deepStrictEqual(
        graph.edges
          .filter((edge) => edge.kind.startsWith("llm-"))
          .map((edge) => `${edge.from}->${edge.to} (${edge.kind})`),
        ["RUNJOB->ACCTXFR (llm-dynamic-call)"]
      )
      const refine = read("graph-refine.md")
      assert.include(refine, "1 of 1 proposed edge(s) merged")
      assert.include(
        refine,
        "EXEC PGM=&PGM",
        "the evidence citation should survive into the audit trail"
      )
      assert.include(refine, "CEE3ABD", "unresolved references belong in the notes section")

      // 3. The inventory is human-readable and lists the estate.
      const inventory = read("inventory.md")
      assert.include(inventory, "ACCTXFR")
      assert.include(inventory, "FEECALC")

      // 4. The wave plan carries the triage, the waves, and — critically — an
      //    UNCHECKED approval marker: extraction must not be able to start.
      const plan = read("wave-plan.md")
      assert.include(plan, "## Wave: wave-1")
      assert.include(plan, "## Wave: wave-2")
      assert.include(plan, "| FEECALC | rewrite |")
      assert.include(plan, "| RUNJOB | wrap |")
      assert.include(plan, "- [ ] Approved")
      assert.notInclude(plan, "- [x] Approved")
      // No bench records exist here, so the plan ships without a projection.
      assert.notInclude(plan, "## Cost projection")

      // 5. The artifacts were committed, not just written.
      const log = execFileSync("git", ["log", "--oneline", "-1"], {
        cwd: join(estate.root, "estate"),
        encoding: "utf8"
      })
      assert.include(log, "modernize(cobol-springboot): survey")
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: join(estate.root, "estate"),
        encoding: "utf8"
      })
      assert.strictEqual(status.trim(), "", "the survey should leave a clean tree")
    } finally {
      rmSync(estate.root, { recursive: true, force: true })
    }
  })

  // The launch directory has no packs/ at all — the pack must come from the
  // flow script's own directory, the layout `llm4ts run modernize-survey`
  // launches with from an arbitrary cwd.
  it("finds the built-in pack when launched outside the llm4ts workspace", () => {
    const estate = makeEstate()
    try {
      const result = runSurvey(estate, estate.root)
      assert.strictEqual(
        result.status,
        0,
        `survey exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
      )
      const plan = readFileSync(
        join(estate.root, "estate", "docs", "modernization", "wave-plan.md"),
        "utf8"
      )
      assert.include(plan, "- [ ] Approved")
    } finally {
      rmSync(estate.root, { recursive: true, force: true })
    }
  })
})

describe("modernize-survey over a J2EE estate (model stubbed)", () => {
  it("survives a large build tree, resolves fragment includes, and prompts in J2EE terms", () => {
    const estate = makeJ2eeEstate()
    try {
      const result = runSurvey(estate, estate.root, "packs/j2ee-nextjs-spa")
      assert.strictEqual(
        result.status,
        0,
        `survey exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
      )

      const modDir = join(estate.root, "estate", "docs", "modernization")
      const read = (name: string): string => readFileSync(join(modDir, name), "utf8")

      // 1. Discovery counted sources, not the 1 200 class files, the git
      //    object store, or the stale copies under target/.
      const graph = Schema.decodeUnknownSync(SurveyGraph)(JSON.parse(read("graph.json")))
      assert.deepStrictEqual(graph.nodes.map((node) => node.name).sort(), [
        "LoginServlet",
        "footer",
        "header",
        "login",
        "web"
      ])
      assert.isFalse(graph.nodes.some((node) => node.path.startsWith("target/")))

      // 2. Path-shaped includes resolved onto the fragment units, so the
      //    layout fragments carry their callers instead of a retire flag.
      assert.deepStrictEqual(
        graph.edges.map((edge) => `${edge.from}->${edge.to} (${edge.kind})`).sort(),
        [
          "login->footer (jsp-include)",
          "login->header (jsp-include)",
          "web->LoginServlet (servlet-class)"
        ]
      )
      const inventory = read("inventory.md")
      assert.notMatch(inventory, /\| header \|.*retire candidate/)
      assert.notMatch(inventory, /\| footer \|.*retire candidate/)

      // 3. Both reasoning prompts carried the pack's J2EE guidance and the
      //    graph's provenance, and none of the COBOL wording that used to be
      //    hard-coded in the flow.
      const prompts = readFileSync(join(estate.binDir, "prompts.log"), "utf8").split(
        "=== END PROMPT ==="
      )
      const refine = prompts.find((prompt) => prompt.includes("refining the dependency graph"))
      const triage = prompts.find((prompt) => prompt.includes("triaging a legacy estate"))
      assert.isDefined(refine)
      assert.isDefined(triage)
      for (const prompt of [refine ?? "", triage ?? ""]) {
        assert.include(prompt, "jsp-include, servlet-class")
        assert.include(prompt, "web.xml")
        assert.notMatch(prompt, /COBOL|JCL|COPY|EXEC PGM/)
      }
      assert.include(refine ?? "", "Units: LoginServlet, footer, header, login, web")

      // 4. The plan is there, unapproved, and committed under the pack's name.
      const plan = read("wave-plan.md")
      assert.include(plan, "## Wave: wave-1")
      assert.include(plan, "| header | rewrite |")
      assert.include(plan, "- [ ] Approved")
      const log = execFileSync("git", ["log", "--oneline", "-1"], {
        cwd: join(estate.root, "estate"),
        encoding: "utf8"
      })
      assert.include(log, "modernize(j2ee-nextjs-spa): survey")
    } finally {
      rmSync(estate.root, { recursive: true, force: true })
    }
  })
})
