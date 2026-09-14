import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { discoverKits } from "@llm4ts/runner/Kits"
import { loadKitPatternCards, locatePack, openPack } from "@llm4ts/runner/Packs"

const minimalPack = (name: string): string => `# Pack: ${name}\n\nsource: cobol\n`

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "llm4ts-packs-"))

const writePack = (directory: string, name: string): void => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "pack.md"), minimalPack(name))
}

/** A checkout-shaped root: flows/ beside kits/<kit>/packs/<pack>. */
const writeCheckout = (root: string): { flowDir: string; kitsDir: string } => {
  const flowDir = join(root, "flows")
  mkdirSync(flowDir, { recursive: true })
  writePack(join(root, "kits", "mainframe", "packs", "cobol-springboot"), "cobol-springboot")
  writePack(join(root, "kits", "web", "packs", "jsp-nextjs"), "jsp-nextjs")
  mkdirSync(join(root, "kits", "mainframe", "patterns"), { recursive: true })
  writeFileSync(
    join(root, "kits", "mainframe", "patterns", "PAT-001-money.md"),
    ["# PAT-001 money", "", "match: COMP-3", "", "Use BigDecimal.", ""].join("\n")
  )
  return { flowDir, kitsDir: join(root, "kits") }
}

describe("locatePack", () => {
  it("resolves absolute and launch-relative paths before kits", () => {
    const root = makeRoot()
    try {
      writePack(join(root, "packs", "mine"), "mine")
      const absolute = locatePack(join(root, "packs", "mine"), {
        launchDir: "/elsewhere",
        kits: []
      })
      assert.deepStrictEqual(absolute, {
        _tag: "Located",
        root: join(root, "packs", "mine"),
        dir: "."
      })
      const relative = locatePack("packs/mine", { launchDir: root, kits: [] })
      assert.deepStrictEqual(relative, { _tag: "Located", root, dir: "packs/mine" })
      assert.deepStrictEqual(locatePack("packs/absent", { launchDir: root, kits: [] }), {
        _tag: "Absent"
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("resolves bare and kit-qualified names through the discovered kits", () => {
    const root = makeRoot()
    try {
      const { kitsDir } = writeCheckout(root)
      const kits = discoverKits({ builtin: kitsDir })
      const bare = locatePack("jsp-nextjs", { launchDir: root, kits })
      assert.strictEqual(bare._tag, "Located")
      if (bare._tag === "Located") {
        assert.strictEqual(bare.root, join(kitsDir, "web"))
        assert.strictEqual(bare.dir, join("packs", "jsp-nextjs"))
        assert.strictEqual(bare.kit?.name, "web")
      }
      const qualified = locatePack("mainframe/cobol-springboot", { launchDir: root, kits })
      assert.strictEqual(qualified._tag === "Located" ? qualified.kit?.name : "", "mainframe")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("openPack", () => {
  it.effect("opens the default pack from the kits beside the flow, from any launch directory", () =>
    Effect.gen(function* () {
      const root = makeRoot()
      const launch = makeRoot()
      try {
        const { flowDir } = writeCheckout(root)
        const opened = yield* openPack({ environment: {}, launchDir: launch, flowDir })
        assert.strictEqual(opened.pack.name, "cobol-springboot")
        assert.strictEqual(opened.dir, join("packs", "cobol-springboot"))
        assert.strictEqual(opened.kit?.name, "mainframe")
        const cards = yield* loadKitPatternCards(opened)
        assert.deepStrictEqual(
          cards.map((card) => card.id),
          ["PAT-001-money"]
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(launch, { recursive: true, force: true })
      }
    })
  )

  it.effect("a path-form pack has no kit and contributes no kit cards", () =>
    Effect.gen(function* () {
      const root = makeRoot()
      try {
        const { flowDir } = writeCheckout(root)
        writePack(join(root, "packs", "draft"), "draft")
        const opened = yield* openPack({
          environment: { LLM4TS_PACK: "packs/draft" },
          launchDir: root,
          flowDir
        })
        assert.strictEqual(opened.pack.name, "draft")
        assert.isUndefined(opened.kit)
        assert.deepStrictEqual(yield* loadKitPatternCards(opened), [])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  )

  it.effect("names the known packs when the reference resolves nowhere", () =>
    Effect.gen(function* () {
      const root = makeRoot()
      try {
        const { flowDir } = writeCheckout(root)
        const error = yield* openPack({
          environment: { LLM4TS_PACK: "absent" },
          launchDir: root,
          flowDir
        }).pipe(Effect.flip)
        assert.strictEqual(error._tag, "PackNotFound")
        assert.include(error.message, "mainframe/cobol-springboot")
        assert.include(error.message, "web/jsp-nextjs")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  )

  it.effect("refuses an ambiguous bare name within one tier", () =>
    Effect.gen(function* () {
      const root = makeRoot()
      try {
        const { flowDir } = writeCheckout(root)
        writePack(join(root, "kits", "web", "packs", "cobol-springboot"), "cobol-springboot")
        const error = yield* openPack({ environment: {}, launchDir: root, flowDir }).pipe(
          Effect.flip
        )
        assert.strictEqual(error._tag, "PackNotFound")
        assert.include(error.message, "mainframe/cobol-springboot, web/cobol-springboot")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  )
})
