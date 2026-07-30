import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import { defaultTierPaths, discoverFlows, parseFlowDescription } from "@llm4ts/shell/FlowCatalog"

describe("parseFlowDescription", () => {
  it("returns the first non-empty leading comment line", () => {
    assert.strictEqual(
      parseFlowDescription("// Implement a plan task by task.\nimport x from 'y'\n"),
      "Implement a plan task by task."
    )
  })

  it("skips blank lines and empty comment lines", () => {
    assert.strictEqual(
      parseFlowDescription("\n//\n//   \n// The real description\ncode()\n"),
      "The real description"
    )
  })

  it("returns undefined when code precedes any comment", () => {
    assert.isUndefined(parseFlowDescription('import x from "y"\n// too late\n'))
  })

  it("returns undefined for an empty file", () => {
    assert.isUndefined(parseFlowDescription(""))
  })
})

describe("defaultTierPaths", () => {
  it("honours XDG_CONFIG_HOME for the global tier", () => {
    const tiers = defaultTierPaths({
      cwd: "/work",
      homeDir: "/home/rm",
      environment: { XDG_CONFIG_HOME: "/xdg" },
      builtinDir: "/builtin"
    })
    assert.strictEqual(tiers.project, join("/work", ".llm4ts", "flows"))
    assert.strictEqual(tiers.global, join("/xdg", "llm4ts", "flows"))
    assert.strictEqual(tiers.builtin, "/builtin")
  })

  it("falls back to ~/.config without XDG_CONFIG_HOME", () => {
    const tiers = defaultTierPaths({ cwd: "/work", homeDir: "/home/rm", environment: {} })
    assert.strictEqual(tiers.global, join("/home/rm", ".config", "llm4ts", "flows"))
    assert.isUndefined(tiers.builtin)
  })
})

describe("discoverFlows", () => {
  const withTempDir = <A>(use: (dir: string) => Promise<A>): Promise<A> => {
    const dir = mkdtempSync(join(tmpdir(), "llm4ts-shell-test-"))
    return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  const runDiscovery = (tiers: {
    readonly project?: string
    readonly global?: string
    readonly builtin?: string
  }) => Effect.runPromise(discoverFlows(tiers).pipe(Effect.provide(NodeFileSystem.layer)))

  it("applies project > global > builtin precedence with shadow annotations", () =>
    withTempDir(async (dir) => {
      const project = join(dir, "project")
      const global = join(dir, "global")
      const builtin = join(dir, "builtin")
      for (const tier of [project, global, builtin]) {
        mkdirSync(tier, { recursive: true })
      }
      writeFileSync(join(project, "implement.ts"), "// project implement\n")
      writeFileSync(join(global, "implement.ts"), "// global implement\n")
      writeFileSync(join(builtin, "implement.ts"), "// builtin implement\n")
      writeFileSync(join(builtin, "issue-pr.ts"), "// builtin issue-pr\n")

      const flows = await runDiscovery({ project, global, builtin })
      assert.deepStrictEqual(
        flows.map((flow) => [flow.name, flow.tier, flow.description, [...flow.shadows]]),
        [
          ["implement", "project", "project implement", ["global", "builtin"]],
          ["issue-pr", "builtin", "builtin issue-pr", []]
        ]
      )
    }))

  it("treats missing directories as empty tiers", () =>
    withTempDir(async (dir) => {
      const builtin = join(dir, "builtin")
      mkdirSync(builtin, { recursive: true })
      writeFileSync(join(builtin, "sdd.ts"), "code()\n")

      const flows = await runDiscovery({
        project: join(dir, "does-not-exist"),
        global: join(dir, "also-missing"),
        builtin
      })
      assert.strictEqual(flows.length, 1)
      assert.strictEqual(flows[0]?.name, "sdd")
      assert.isUndefined(flows[0]?.description)
    }))

  it("ignores files that are not .ts scripts", () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "README.md"), "# not a flow\n")
      writeFileSync(join(dir, "flow.ts"), "// a flow\n")

      const flows = await runDiscovery({ project: dir })
      assert.deepStrictEqual(
        flows.map((flow) => flow.name),
        ["flow"]
      )
    }))
})
