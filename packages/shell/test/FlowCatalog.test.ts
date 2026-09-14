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

describe("discoverFlows with kits", () => {
  it("lists kit flows under the kit's tier, labelled with the kit, after the tier's own flows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm4ts-shell-kits-"))
    try {
      mkdirSync(join(dir, "builtin"), { recursive: true })
      writeFileSync(join(dir, "builtin", "implement.js"), "// Engine implement\n")
      mkdirSync(join(dir, "kits", "web", "flows", "lib"), { recursive: true })
      writeFileSync(join(dir, "kits", "web", "flows", "convert-page.js"), "// Convert a page\n")
      writeFileSync(join(dir, "kits", "web", "flows", "lib", "helper.js"), "export const x = 1\n")
      mkdirSync(join(dir, "project"), { recursive: true })
      writeFileSync(join(dir, "project", "convert-page.ts"), "// My convert\n")

      const flows = await Effect.runPromise(
        discoverFlows({
          project: join(dir, "project"),
          builtin: join(dir, "builtin"),
          kits: { builtin: join(dir, "kits") }
        }).pipe(Effect.provide(NodeFileSystem.layer))
      )
      assert.deepStrictEqual(
        flows.map((flow) => [flow.name, flow.tier, flow.kit, flow.description, flow.shadows]),
        [
          ["convert-page", "project", undefined, "My convert", ["builtin"]],
          ["implement", "builtin", undefined, "Engine implement", []]
        ]
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("labels a kit flow with its kit when nothing shadows it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm4ts-shell-kits-"))
    try {
      mkdirSync(join(dir, "kits", "web", "flows"), { recursive: true })
      writeFileSync(join(dir, "kits", "web", "flows", "convert-page.js"), "// Convert a page\n")
      const flows = await Effect.runPromise(
        discoverFlows({ kits: { global: join(dir, "kits") } }).pipe(
          Effect.provide(NodeFileSystem.layer)
        )
      )
      assert.deepStrictEqual(
        flows.map((flow) => [flow.name, flow.tier, flow.kit]),
        [["convert-page", "global", "web"]]
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  it("ignores files that are not flow scripts", () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "README.md"), "# not a flow\n")
      writeFileSync(join(dir, "flow.ts"), "// a flow\n")

      const flows = await runDiscovery({ project: dir })
      assert.deepStrictEqual(
        flows.map((flow) => flow.name),
        ["flow"]
      )
    }))

  // The shipped built-in tier is transpiled JavaScript: Node refuses to strip
  // types under node_modules, so an installed shell can only launch .js flows.
  it("discovers .js flows, as the built-in tier ships them", () =>
    withTempDir(async (dir) => {
      const builtin = join(dir, "builtin")
      mkdirSync(builtin, { recursive: true })
      writeFileSync(join(builtin, "modernize-survey.js"), "// survey the estate\n")
      const project = join(dir, "project")
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, "modernize-survey.ts"), "// project survey override\n")

      const flows = await runDiscovery({ project, builtin })
      assert.deepStrictEqual(
        flows.map((flow) => [flow.name, flow.tier, flow.description, [...flow.shadows]]),
        [["modernize-survey", "project", "project survey override", ["builtin"]]]
      )
    }))
})
