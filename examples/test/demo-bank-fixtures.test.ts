import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"

// CI smoke for the demo-bank fixtures: each script seeds its fixture into a
// temp directory as a standalone git repo and asserts the expected file set —
// filesystem and git only, no network, no package installs.
const demoBank = join(dirname(fileURLToPath(import.meta.url)), "..", "demo-bank")

const smoke = (script: string): string =>
  execFileSync("node", [join(demoBank, script)], { encoding: "utf8" })

describe("demo-bank fixtures", () => {
  it("legacy J2EE fixture seeds deterministically", () => {
    assert.include(smoke("smoke-legacy-j2ee.mjs"), "OK")
  })

  it("Next.js target fixture seeds deterministically", () => {
    assert.include(smoke("smoke-nextjs.mjs"), "OK")
  })
})
