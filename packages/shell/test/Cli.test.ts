import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Effect from "effect/Effect"
import type { FileSystem } from "effect/FileSystem"
import { renderFlowList, resolveFlow } from "@llm4ts/shell/Cli"
import type { DiscoveredFlow } from "@llm4ts/shell/FlowCatalog"

const flows: ReadonlyArray<DiscoveredFlow> = [
  {
    name: "implement",
    path: "/tiers/project/implement.ts",
    tier: "project",
    description: "Persistent plan flow",
    shadows: ["builtin"]
  },
  { name: "issue-pr", path: "/tiers/builtin/issue-pr.ts", tier: "builtin", shadows: [] }
]

describe("renderFlowList", () => {
  it("renders aligned rows with tier and shadow annotations", () => {
    assert.strictEqual(
      renderFlowList(flows),
      ["implement  [project shadows builtin]  Persistent plan flow", "issue-pr   [builtin]"].join(
        "\n"
      )
    )
  })

  it("renders machine-readable JSON on request", () => {
    const parsed: unknown = JSON.parse(renderFlowList(flows, { json: true }))
    assert.deepStrictEqual(parsed, [
      {
        name: "implement",
        tier: "project",
        path: "/tiers/project/implement.ts",
        description: "Persistent plan flow",
        shadows: ["builtin"]
      },
      {
        name: "issue-pr",
        tier: "builtin",
        path: "/tiers/builtin/issue-pr.ts",
        shadows: []
      }
    ])
  })

  it("renders an empty JSON array when nothing is discovered", () => {
    assert.strictEqual(renderFlowList([], { json: true }), "[]")
  })
})

describe("resolveFlow", () => {
  const withTempDir = <A>(use: (dir: string) => Promise<A>): Promise<A> => {
    const dir = mkdtempSync(join(tmpdir(), "llm4ts-shell-cli-"))
    return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem>) =>
    Effect.runPromise(Effect.result(effect).pipe(Effect.provide(NodeFileSystem.layer)))

  it("resolves a discovered flow by name with project precedence", () =>
    withTempDir(async (dir) => {
      const project = join(dir, "project")
      const builtin = join(dir, "builtin")
      mkdirSync(project, { recursive: true })
      mkdirSync(builtin, { recursive: true })
      writeFileSync(join(project, "implement.ts"), "// project\n")
      writeFileSync(join(builtin, "implement.ts"), "// builtin\n")

      const result = await run(resolveFlow("implement", { project, builtin }))
      assert.isTrue(result._tag === "Success")
      if (result._tag === "Success") {
        assert.strictEqual(result.success, join(project, "implement.ts"))
      }
    }))

  it("accepts an explicit script path", () =>
    withTempDir(async (dir) => {
      const flowPath = join(dir, "custom.ts")
      writeFileSync(flowPath, "// custom\n")
      const result = await run(resolveFlow(flowPath, {}))
      assert.isTrue(result._tag === "Success")
      if (result._tag === "Success") {
        assert.strictEqual(result.success, flowPath)
      }
    }))

  it("fails with a usage error for an unknown name", () =>
    withTempDir(async (dir) => {
      const builtin = join(dir, "builtin")
      mkdirSync(builtin, { recursive: true })
      writeFileSync(join(builtin, "implement.ts"), "// builtin\n")

      const result = await run(resolveFlow("nope", { builtin }))
      assert.isTrue(result._tag === "Failure")
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "ShellUsage")
        assert.include(String(result.failure.message), "implement")
      }
    }))

  it("fails with a usage error for a missing explicit path", () =>
    withTempDir(async (dir) => {
      const result = await run(resolveFlow(join(dir, "absent.ts"), {}))
      assert.isTrue(result._tag === "Failure")
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "ShellUsage")
      }
    }))
})
