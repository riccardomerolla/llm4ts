import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  builtinKitsDir,
  discoverKits,
  findPack,
  kitTierPaths,
  parseKitDescription
} from "@llm4ts/runner/Kits"

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "llm4ts-kits-"))

const writeKit = (
  tierDir: string,
  name: string,
  options: { packs?: ReadonlyArray<string>; flows?: ReadonlyArray<string>; readme?: string } = {}
): string => {
  const root = join(tierDir, name)
  mkdirSync(root, { recursive: true })
  for (const pack of options.packs ?? []) {
    mkdirSync(join(root, "packs", pack), { recursive: true })
    writeFileSync(join(root, "packs", pack, "pack.md"), `# Pack: ${pack}\n\nsource: cobol\n`)
  }
  for (const flow of options.flows ?? []) {
    mkdirSync(join(root, "flows", "lib"), { recursive: true })
    writeFileSync(join(root, "flows", `${flow}.ts`), `// ${flow} flow\n`)
    writeFileSync(join(root, "flows", "lib", "helper.ts"), "export const x = 1\n")
  }
  if (options.readme !== undefined) {
    writeFileSync(join(root, "README.md"), options.readme)
  }
  return root
}

describe("kitTierPaths", () => {
  it("mirrors the flow tiers under kits/", () => {
    const tiers = kitTierPaths({
      cwd: "/work",
      homeDir: "/home/rm",
      environment: { XDG_CONFIG_HOME: "/xdg" },
      builtinDir: "/shell/kits"
    })
    assert.strictEqual(tiers.project, join("/work", ".llm4ts", "kits"))
    assert.strictEqual(tiers.global, join("/xdg", "llm4ts", "kits"))
    assert.strictEqual(tiers.builtin, "/shell/kits")
  })
})

describe("builtinKitsDir", () => {
  it("finds the kits/ directory beside the engine flows, walking up from a kit flow too", () => {
    const root = makeRoot()
    try {
      mkdirSync(join(root, "flows"), { recursive: true })
      mkdirSync(join(root, "kits", "demo", "flows"), { recursive: true })
      assert.strictEqual(builtinKitsDir(join(root, "flows")), join(root, "kits"))
      assert.strictEqual(builtinKitsDir(join(root, "kits", "demo", "flows")), join(root, "kits"))
      assert.isUndefined(builtinKitsDir(join(root, "elsewhere", "deep", "down", "here", "there")))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("parseKitDescription", () => {
  it("returns the first paragraph line after the title", () => {
    assert.strictEqual(
      parseKitDescription(
        "# Kit: mainframe-java\n\nCOBOL and ACE estates to Spring Boot.\n\nMore.\n"
      ),
      "COBOL and ACE estates to Spring Boot."
    )
    assert.isUndefined(parseKitDescription("# Title only\n"))
  })
})

describe("discoverKits", () => {
  it("lists packs and flows per kit with project > global > builtin shadowing", () => {
    const root = makeRoot()
    try {
      const project = join(root, "project")
      const builtin = join(root, "builtin")
      writeKit(builtin, "mainframe", {
        packs: ["cobol-springboot", "ace-kafka"],
        readme: "# mainframe\n\nMainframe estates.\n"
      })
      writeKit(builtin, "web", { packs: ["jsp-nextjs"], flows: ["convert-page"] })
      writeKit(project, "mainframe", { packs: ["cobol-springboot"] })
      mkdirSync(join(project, "not-a-kit"), { recursive: true })

      const kits = discoverKits({ project, builtin })
      assert.deepStrictEqual(
        kits.map((kit) => [kit.name, kit.tier, kit.packs, kit.flows, kit.shadows]),
        [
          ["mainframe", "project", ["cobol-springboot"], [], ["builtin"]],
          ["web", "builtin", ["jsp-nextjs"], ["convert-page"], []]
        ]
      )
      assert.isUndefined(kits[0]?.description)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("contributes nothing for missing tier directories", () => {
    assert.deepStrictEqual(discoverKits({ project: "/nowhere/at/all" }), [])
  })
})

describe("findPack", () => {
  const root = makeRoot()
  const project = join(root, "project")
  const builtin = join(root, "builtin")
  writeKit(builtin, "a", { packs: ["shared", "only-a"] })
  writeKit(builtin, "b", { packs: ["shared"] })
  writeKit(project, "mine", { packs: ["shared"] })
  const kits = discoverKits({ project, builtin })

  it("resolves a bare name in the highest tier that ships it", () => {
    const found = findPack("shared", kits)
    assert.strictEqual(found._tag, "Found")
    assert.strictEqual(found._tag === "Found" ? found.kit.name : "", "mine")
  })

  it("reports an ambiguity only within one tier", () => {
    const found = findPack("only-a", kits)
    assert.strictEqual(found._tag === "Found" ? found.kit.name : "", "a")
    const project = discoverKits({ builtin })
    const ambiguous = findPack("shared", project)
    assert.deepStrictEqual(ambiguous, { _tag: "Ambiguous", candidates: ["a/shared", "b/shared"] })
  })

  it("resolves kit/pack names and reports unknown ones", () => {
    const found = findPack("b/shared", kits)
    assert.strictEqual(found._tag === "Found" ? found.kit.name : "", "b")
    assert.deepStrictEqual(findPack("b/only-a", kits), { _tag: "Absent" })
    assert.deepStrictEqual(findPack("nope", kits), { _tag: "Absent" })
  })
})
