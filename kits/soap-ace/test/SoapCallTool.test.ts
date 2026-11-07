import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ToolReport } from "@llm4ts/flow/tools/Tool"
import { WsdlCatalog } from "../flows/lib/soap/Catalog.ts"
import { samplePaths, renderRequestFile } from "../flows/lib/soap/Samples.ts"
import { servicePaths } from "../flows/lib/soap/Discover.ts"
import { demoCatalog, demoResponses } from "./support.ts"

const toolFile = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "soap-call.ts")
const service = "DemoBankService"

const run = (project: string, stdin: string) =>
  spawnSync(process.execPath, ["--experimental-strip-types", toolFile, "--project", project], {
    encoding: "utf8",
    input: stdin,
    env: { ...process.env, NODE_NO_WARNINGS: "1", LLM4TS_SOAP_STUB: demoResponses }
  })

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ToolReport))

describe("soap-call kit tool", () => {
  it.effect("calls a read operation through the policy and refuses a mutating one", () =>
    Effect.gen(function* () {
      const catalog = yield* demoCatalog
      const project = mkdtempSync(join(tmpdir(), "llm4ts-soap-call-"))
      try {
        const paths = servicePaths(service)
        mkdirSync(join(project, paths.directory), { recursive: true })
        writeFileSync(
          join(project, paths.catalog),
          JSON.stringify(Schema.encodeSync(WsdlCatalog)(catalog))
        )
        writeFileSync(
          join(project, paths.operations),
          [
            "Status: confirmed",
            "## cercaConti",
            "- class: read",
            "## revocaBonifico",
            "- class: mutating",
            ""
          ].join("\n")
        )
        writeFileSync(
          join(project, `${paths.directory}/auth.json`),
          JSON.stringify({ environment: "dev", endpoint: "https://bank.local/soap" })
        )
        for (const [operation, body] of [
          ["cercaConti", { codiceFiscale: "RSSMRA85T10A562S" }],
          ["revocaBonifico", undefined]
        ] as const) {
          const yaml = samplePaths(service, operation, "probe").yaml
          mkdirSync(dirname(join(project, yaml)), { recursive: true })
          writeFileSync(
            join(project, yaml),
            renderRequestFile({
              catalog,
              operation,
              purpose: "probe",
              ...(body === undefined ? {} : { body })
            })
          )
        }
        const read = run(
          project,
          JSON.stringify({ service, operation: "cercaConti", request: "probe" })
        )
        assert.strictEqual(read.status, 0, read.stdout + read.stderr)
        const report = decode(read.stdout.trim())
        assert.isTrue(report.ok)
        assert.match(report.summary, /cercaConti\/probe answered 200/)
        const mutating = run(
          project,
          JSON.stringify({ service, operation: "revocaBonifico", request: "probe" })
        )
        assert.strictEqual(mutating.status, 1, mutating.stdout + mutating.stderr)
        const refused = decode(mutating.stdout.trim())
        assert.match(refused.issues[0]?.detail ?? "", /^refused: /)
        const unknown = run(
          project,
          JSON.stringify({ service: "Nope", operation: "x", request: "y" })
        )
        assert.strictEqual(unknown.status, 2)
        assert.match(unknown.stdout, /no catalog for service 'Nope'/)
      } finally {
        rmSync(project, { recursive: true, force: true })
      }
    })
  )
})
