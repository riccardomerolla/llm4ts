import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  defaultExcludedDirectories,
  defaultWorkspaceLimits,
  discoveryOverflowAdvice,
  isExcludedPath,
  legacySourceWorkspaceLimits,
  makeMemoryWorkspace,
  workspaceLimitsFromEnv
} from "@llm4ts/flow/Workspace"

describe("legacySourceWorkspaceLimits", () => {
  it("raises the read and discovery caps above the defaults, nothing else", () => {
    assert.isAbove(legacySourceWorkspaceLimits.maxReadBytes, defaultWorkspaceLimits.maxReadBytes)
    assert.isAbove(legacySourceWorkspaceLimits.maxResults, defaultWorkspaceLimits.maxResults)
    assert.strictEqual(
      legacySourceWorkspaceLimits.maxWriteBytes,
      defaultWorkspaceLimits.maxWriteBytes
    )
    assert.strictEqual(legacySourceWorkspaceLimits.maxDepth, defaultWorkspaceLimits.maxDepth)
    assert.deepStrictEqual(legacySourceWorkspaceLimits.excludeDirs, defaultExcludedDirectories)
  })

  it("prunes version control, dependency, and build output directories by default", () => {
    for (const name of [".git", "node_modules", "target", "build", "dist"]) {
      assert.include(defaultExcludedDirectories, name)
    }
  })
})

describe("workspaceLimitsFromEnv", () => {
  it("overrides the read cap with a positive integer LLM4TS_MAX_READ_BYTES", () => {
    const limits = workspaceLimitsFromEnv(
      { LLM4TS_MAX_READ_BYTES: "16777216" },
      legacySourceWorkspaceLimits
    )
    assert.strictEqual(limits.maxReadBytes, 16_777_216)
    assert.strictEqual(limits.maxWriteBytes, legacySourceWorkspaceLimits.maxWriteBytes)
    assert.strictEqual(limits.maxResults, legacySourceWorkspaceLimits.maxResults)
  })

  it("overrides the discovery cap with a positive integer LLM4TS_MAX_DISCOVER_RESULTS", () => {
    const limits = workspaceLimitsFromEnv(
      { LLM4TS_MAX_DISCOVER_RESULTS: "50000" },
      legacySourceWorkspaceLimits
    )
    assert.strictEqual(limits.maxResults, 50_000)
    assert.strictEqual(limits.maxReadBytes, legacySourceWorkspaceLimits.maxReadBytes)
  })

  it("replaces the pruned directories with LLM4TS_EXCLUDE_DIRS, ignoring paths", () => {
    const limits = workspaceLimitsFromEnv(
      { LLM4TS_EXCLUDE_DIRS: " .git, generated ,, vendor/lib " },
      legacySourceWorkspaceLimits
    )
    assert.deepStrictEqual(limits.excludeDirs, [".git", "generated"])
  })

  it("keeps the defaults for unset, empty, non-numeric, or non-positive values", () => {
    for (const value of [undefined, "", "  ", "lots", "-1", "0", "1.5"]) {
      const environment =
        value === undefined
          ? {}
          : { LLM4TS_MAX_READ_BYTES: value, LLM4TS_MAX_DISCOVER_RESULTS: value }
      assert.strictEqual(
        workspaceLimitsFromEnv(environment, legacySourceWorkspaceLimits),
        legacySourceWorkspaceLimits
      )
    }
    assert.strictEqual(
      workspaceLimitsFromEnv({ LLM4TS_EXCLUDE_DIRS: " , " }, legacySourceWorkspaceLimits),
      legacySourceWorkspaceLimits
    )
  })
})

describe("isExcludedPath", () => {
  it("matches a pruned directory name at any depth, never a file name", () => {
    assert.isTrue(isExcludedPath(".git/objects/ab/cdef", defaultWorkspaceLimits))
    assert.isTrue(isExcludedPath("web/target/classes/App.class", defaultWorkspaceLimits))
    assert.isFalse(isExcludedPath("src/main/java/Target.java", defaultWorkspaceLimits))
    assert.isFalse(isExcludedPath("docs/build", defaultWorkspaceLimits))
    assert.isFalse(isExcludedPath(".git/config", { ...defaultWorkspaceLimits, excludeDirs: [] }))
  })
})

describe("discoveryOverflowAdvice", () => {
  it("names the cap and every knob that narrows or raises it", () => {
    const advice = discoveryOverflowAdvice(legacySourceWorkspaceLimits)
    assert.include(advice, String(legacySourceWorkspaceLimits.maxResults))
    assert.include(advice, "sources:")
    assert.include(advice, "exclude:")
    assert.include(advice, "LLM4TS_EXCLUDE_DIRS")
    assert.include(advice, "LLM4TS_MAX_DISCOVER_RESULTS")
    assert.include(advice, ".git,")
  })
})

describe("memory workspace discovery", () => {
  it.effect("prunes excluded directories and counts only matching files against the cap", () =>
    Effect.gen(function* () {
      const initial: Record<string, string> = {
        "src/main/webapp/login.jsp": '<jsp:include page="header.jsp" />',
        "src/main/webapp/header.jsp": "<h1/>",
        "src/main/webapp/WEB-INF/lib/one.jar": "PK",
        "src/main/webapp/WEB-INF/lib/two.jar": "PK",
        "src/main/webapp/WEB-INF/web.xml": "<web-app/>",
        "target/classes/Login.class": "CAFEBABE",
        ".git/objects/aa/bb": "blob"
      }
      const workspace = yield* makeMemoryWorkspace({
        limits: { ...defaultWorkspaceLimits, maxResults: 3 },
        initial
      })

      // Three JSP/XML sources under a cap of three: the jars, the class file,
      // and the git object must not be the ones that spend it.
      const sources = yield* workspace.discover("**/*", { matching: /\.(jsp|xml)$/ })
      assert.deepStrictEqual([...sources].sort(), [
        "src/main/webapp/WEB-INF/web.xml",
        "src/main/webapp/header.jsp",
        "src/main/webapp/login.jsp"
      ])

      const excluded = yield* workspace.discover("**/*", {
        matching: /\.(jsp|xml)$/,
        excluding: /header/
      })
      assert.deepStrictEqual([...excluded].sort(), [
        "src/main/webapp/WEB-INF/web.xml",
        "src/main/webapp/login.jsp"
      ])

      // Without the filter the same cap overflows on the jars — the failure
      // the survey used to hit on any real estate.
      const overflow = yield* Effect.flip(workspace.discover())
      assert.strictEqual(overflow._tag, "WorkspaceLimit")

      // Pruned directories are invisible even to an unfiltered discovery.
      const everything = yield* workspace.discover("**/*", { matching: /class|objects/ })
      assert.deepStrictEqual(everything, [])
      const unpruned = yield* makeMemoryWorkspace({
        limits: { ...defaultWorkspaceLimits, excludeDirs: [] },
        initial
      })
      assert.deepStrictEqual(yield* unpruned.discover("**/*", { matching: /class|objects/ }), [
        ".git/objects/aa/bb",
        "target/classes/Login.class"
      ])
    })
  )
})
