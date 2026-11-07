import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { DiscoveredKit } from "@llm4ts/runner/Kits"
import {
  builtinSpecs,
  catalogEntries,
  catalogJson,
  findEntry,
  projectRootOf,
  renderCatalog,
  resolvePreset,
  toolBrief,
  type ToolCatalog
} from "@llm4ts/runner/Tools"

const kitAt = (
  root: string,
  tier: DiscoveredKit["tier"],
  tools: ReadonlyArray<string>
): DiscoveredKit => ({
  name: `kit-${tier}`,
  root,
  tier,
  packs: [],
  flows: [],
  tools,
  shadows: []
})

describe("tool catalog", () => {
  it("unions the built-in tools with every kit's tools/, project kits shadowing", () => {
    const base = mkdtempSync(join(tmpdir(), "llm4ts-tools-"))
    try {
      const builtinKit = join(base, "builtin")
      const projectKit = join(base, "project")
      mkdirSync(join(builtinKit, "tools"), { recursive: true })
      mkdirSync(join(projectKit, "tools"), { recursive: true })
      writeFileSync(join(builtinKit, "tools", "xml-validate.ts"), "")
      writeFileSync(join(builtinKit, "tools", "diff.ts"), "")
      writeFileSync(join(projectKit, "tools", "xml-validate.js"), "")
      writeFileSync(join(projectKit, "tools", "Bad_Name.ts"), "")
      const entries = catalogEntries([
        kitAt(builtinKit, "builtin", ["xml-validate", "diff"]),
        kitAt(projectKit, "project", ["xml-validate", "Bad_Name"])
      ])
      assert.deepStrictEqual(
        entries.map((entry) => `${entry.name}:${entry._tag}`),
        ["diff:kit", "json-validate:builtin", "xml-validate:kit"]
      )
      const xml = findEntry(entries, "xml-validate")
      assert.isTrue(xml?._tag === "kit" && xml.kit.tier === "project")
      assert.isTrue(xml?._tag === "kit" && xml.file.endsWith("xml-validate.js"))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  const catalog: ToolCatalog = {
    entries: catalogEntries([]),
    presets: [
      {
        name: "validate-contract",
        command: ["json-validate", "--openapi", "contracts/openapi.json", "--component", "Page"],
        pack: "jsp-nextjs"
      },
      { name: "broken", command: ["nope"], pack: "jsp-nextjs" },
      { name: "empty", command: [], pack: "jsp-nextjs" }
    ]
  }

  it.effect("resolves a preset to its tool with the fixed arguments first", () =>
    Effect.gen(function* () {
      const resolved = yield* resolvePreset(catalog, "validate-contract", [
        "--document",
        "page.json"
      ])
      assert.strictEqual(resolved?.entry.name, "json-validate")
      assert.deepStrictEqual(resolved?.argv, [
        "--openapi",
        "contracts/openapi.json",
        "--component",
        "Page",
        "--document",
        "page.json"
      ])
      assert.isUndefined(yield* resolvePreset(catalog, "json-validate", []))
      const broken = yield* Effect.flip(resolvePreset(catalog, "broken", []))
      assert.match(broken.message, /'nope', which is not a catalog tool/)
      const empty = yield* Effect.flip(resolvePreset(catalog, "empty", []))
      assert.match(empty.message, /names no tool/)
    })
  )

  it("renders the catalog as text and JSON with purposes and presets", () => {
    const specs = builtinSpecs()
    const text = renderCatalog(catalog, specs)
    assert.include(text, "json-validate --document <path>")
    assert.include(text, "Validate a JSON document")
    assert.include(text, "validate-contract (jsp-nextjs): json-validate --openapi")
    const json = catalogJson(catalog, specs)
    assert.deepStrictEqual(
      typeof json === "object" && json !== null && "presets" in json ? json.presets : undefined,
      [
        {
          name: "validate-contract",
          pack: "jsp-nextjs",
          command: "json-validate --openapi contracts/openapi.json --component Page"
        },
        { name: "broken", pack: "jsp-nextjs", command: "nope" },
        { name: "empty", pack: "jsp-nextjs", command: "" }
      ]
    )
  })

  it("writes the brief with the rule and the pack's presets, or nothing when switched off", () => {
    const brief = toolBrief(catalog.presets, builtinSpecs(), {})
    assert.isDefined(brief)
    assert.include(brief ?? "", "run the\nproject's tool instead of writing a script")
    assert.include(
      brief ?? "",
      "- `llm4ts tool validate-contract` (fixed: --openapi contracts/openapi.json --component Page) — Validate a JSON document"
    )
    assert.isUndefined(toolBrief(catalog.presets, builtinSpecs(), { LLM4TS_TOOL_BRIEF: "off" }))
    const bare = toolBrief([], builtinSpecs(), {}) ?? ""
    assert.notInclude(bare, "presets")
    assert.include(bare, "`llm4ts tool list`")
  })

  it("finds the project of a worktree through git, and falls back to the directory itself", () => {
    const here = projectRootOf(process.cwd())
    assert.isTrue(here.length > 0)
    const base = mkdtempSync(join(tmpdir(), "llm4ts-nogit-"))
    try {
      assert.strictEqual(projectRootOf(base), base)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
