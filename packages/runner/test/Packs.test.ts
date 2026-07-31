import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { loadUniversalPatternCards, locatePack, openPack } from "@llm4ts/runner/Packs"

const minimalPack = ["# Pack: test-pack", "source: cobol", ""].join("\n")

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "llm4ts-packs-"))

const writePack = (root: string, dir: string): void => {
  mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, dir, "pack.md"), minimalPack)
}

describe("locatePack", () => {
  it("prefers the launch directory over the flow directory", () => {
    const launch = makeRoot()
    const flow = makeRoot()
    try {
      writePack(launch, "packs/demo")
      writePack(flow, "packs/demo")
      const located = locatePack("packs/demo", [launch, flow])
      assert.deepStrictEqual(located, { root: launch, dir: "packs/demo" })
    } finally {
      rmSync(launch, { recursive: true, force: true })
      rmSync(flow, { recursive: true, force: true })
    }
  })

  it("falls back to the flow directory when the launch directory has no pack", () => {
    const launch = makeRoot()
    const flow = makeRoot()
    try {
      writePack(flow, "packs/demo")
      const located = locatePack("packs/demo", [launch, flow])
      assert.deepStrictEqual(located, { root: flow, dir: "packs/demo" })
    } finally {
      rmSync(launch, { recursive: true, force: true })
      rmSync(flow, { recursive: true, force: true })
    }
  })

  it("uses an absolute pack path as its own root", () => {
    const root = makeRoot()
    try {
      writePack(root, "the-pack")
      const absolute = join(root, "the-pack")
      assert.deepStrictEqual(locatePack(absolute, [root]), { root: absolute, dir: "." })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reports nothing when no candidate holds a pack.md", () => {
    const root = makeRoot()
    try {
      mkdirSync(join(root, "packs/demo"), { recursive: true })
      assert.isUndefined(locatePack("packs/demo", [root]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("openPack", () => {
  it.effect("loads the built-in pack when launched from an unrelated directory", () =>
    Effect.gen(function* () {
      const launch = makeRoot()
      const flow = makeRoot()
      try {
        writePack(flow, "packs/cobol-springboot")
        const opened = yield* openPack({ environment: {}, launchDir: launch, flowDir: flow })
        assert.strictEqual(opened.pack.name, "test-pack")
        assert.strictEqual(opened.dir, "packs/cobol-springboot")
      } finally {
        rmSync(launch, { recursive: true, force: true })
        rmSync(flow, { recursive: true, force: true })
      }
    })
  )

  it.effect("honours LLM4TS_PACK and names both searched roots when it is missing", () =>
    Effect.gen(function* () {
      const launch = makeRoot()
      const flow = makeRoot()
      try {
        const error = yield* openPack({
          environment: { LLM4TS_PACK: "packs/absent" },
          launchDir: launch,
          flowDir: flow
        }).pipe(Effect.flip)
        assert.strictEqual(error._tag, "PackNotFound")
        assert.include(error.message, "packs/absent")
        assert.include(error.message, launch)
        assert.include(error.message, flow)
        assert.include(error.message, "LLM4TS_PACK")
      } finally {
        rmSync(launch, { recursive: true, force: true })
        rmSync(flow, { recursive: true, force: true })
      }
    })
  )
})

describe("loadUniversalPatternCards", () => {
  it.effect("reads cards from the first root that has a patterns directory", () =>
    Effect.gen(function* () {
      const launch = makeRoot()
      const flow = makeRoot()
      try {
        mkdirSync(join(flow, "patterns"), { recursive: true })
        writeFileSync(
          join(flow, "patterns", "PAT-001.md"),
          ["---", "match: CALL", "---", "Translate CALL statements."].join("\n")
        )
        const cards = yield* loadUniversalPatternCards([launch, flow])
        assert.deepStrictEqual(
          cards.map((card) => card.id),
          ["PAT-001"]
        )
      } finally {
        rmSync(launch, { recursive: true, force: true })
        rmSync(flow, { recursive: true, force: true })
      }
    })
  )

  it.effect("is empty when no root has patterns", () =>
    Effect.gen(function* () {
      const launch = makeRoot()
      try {
        assert.deepStrictEqual(yield* loadUniversalPatternCards([launch]), [])
      } finally {
        rmSync(launch, { recursive: true, force: true })
      }
    })
  )
})
