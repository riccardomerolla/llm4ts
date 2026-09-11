import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"

// CI smoke for the internet-banking portal fixture: the seed script
// materialises it as a standalone git repo in a temp directory and the
// expected file set is asserted — filesystem and git only, no network, no
// package install.
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "internet-banking")

describe("internet-banking fixture", () => {
  it("portal fixture seeds deterministically", () => {
    const output = execFileSync("node", [join(here, "smoke-portal.mjs")], { encoding: "utf8" })
    assert.include(output, "OK")
  })
})
