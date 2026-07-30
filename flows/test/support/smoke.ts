import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Shared harness for the offline modernization smokes.
 *
 * Every flow runs for real — runner, pack loader, workspace, gates, git — with
 * one substitution: the `claude` binary on PATH is a stub that speaks the CLI's
 * `--output-format stream-json` protocol and answers from a canned script. The
 * stub inherits the repository as its working directory, exactly as the real
 * connector does, so it can also simulate a coding agent's edits.
 *
 * The fixture keeps its own pack, whose gates are cheap shell scripts instead
 * of a build toolchain, so phases 3-5 are exercisable without Maven or npm.
 */
// This file lives at flows/test/support/, so the flows root is three levels up.
export const flowsRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export interface Fixture {
  readonly root: string
  readonly binDir: string
  readonly packDir: string
  readonly legacy: string
  readonly target: string
}

export const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" })

export const initRepo = (path: string): void => {
  mkdirSync(path, { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "smoke@llm4ts.test"], { cwd: path, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "llm4ts smoke"], { cwd: path, stdio: "ignore" })
}

export const commitAll = (path: string, message: string): void => {
  execFileSync("git", ["add", "-A"], { cwd: path, stdio: "ignore" })
  execFileSync("git", ["commit", "-qm", message], { cwd: path, stdio: "ignore" })
}

export const write = (root: string, relativePath: string, contents: string): void => {
  const full = join(root, relativePath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

export const writeExecutable = (root: string, relativePath: string, contents: string): void => {
  write(root, relativePath, contents)
  chmodSync(join(root, relativePath), 0o755)
}

/**
 * A pack whose gates are shell scripts in the target repository, so the
 * build/test/verify gates and the replay harness run in milliseconds.
 */
const smokePack = [
  "# Pack: smoke",
  "",
  "source: cobol",
  "scaffold: ../../scaffold",
  "sources: .*\\.(cbl|CBL|jcl|JCL)",
  "programs: .*\\.(cbl|CBL|jcl|JCL)",
  "specs-dir: docs/specs",
  "features-dir: features",
  "replay: sh scripts/replay.sh",
  "",
  "## Gates",
  "",
  "- build: sh scripts/build.sh",
  "- test: sh scripts/test.sh",
  "- verify: sh scripts/test.sh",
  "",
  "## Judge",
  "",
  "- completeness (0..2): Is every rule captured?",
  "- faithfulness (0..2): Is every statement grounded in the source?",
  "",
  "## Equivalence",
  "",
  "- ordering: unordered",
  "",
  "## Coverage: cobol-paragraph",
  "",
  "files: .*\\.(cbl|CBL)",
  "unit: ^ {7}(\\d{4}-[A-Z0-9-]+)\\.",
  "",
  "## Survey: calls",
  "",
  "files: .*\\.(cbl|CBL)",
  "unit: CALL '([A-Z0-9]+)'",
  ""
].join("\n")

export const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "llm4ts-smoke-"))
  const fixture: Fixture = {
    root,
    binDir: join(root, "bin"),
    packDir: join(root, "packs", "smoke"),
    legacy: join(root, "legacy"),
    target: join(root, "target")
  }
  mkdirSync(fixture.binDir, { recursive: true })

  write(root, "packs/smoke/pack.md", smokePack)
  for (const prompt of ["analysis", "spec", "bdd", "plan", "implement", "review", "vectors"]) {
    write(root, `packs/smoke/prompts/${prompt}.md`, `Smoke ${prompt} guidance.\n`)
  }
  write(root, "packs/smoke/lessons.md", "# Lessons\n\n")
  write(
    root,
    "packs/smoke/reviewers/smoke-lens.md",
    ["---", "files: .*", "---", "", "Check the change against the committed specs.", ""].join("\n")
  )
  // The scaffold a seeded target would receive.
  write(root, "scaffold/README.md", "# Seeded target\n")

  return fixture
}

/** Installs the stub coding agent; `script` is the body of a Node program. */
export const installStub = (fixture: Fixture, script: string): void => {
  writeExecutable(fixture.root, "bin/claude", script)
}

/**
 * Wraps a responder in the stream-json envelope the claude CLI connector
 * parses. `respond(prompt)` returns the text the model would emit — usually a
 * JSON document — and may perform side effects first, standing in for the
 * edits a real coding agent makes in the repository.
 */
export const stubProgram = (respondSource: string): string =>
  [
    "#!/usr/bin/env node",
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    "const respond = " + respondSource,
    "const chunks = []",
    'process.stdin.on("data", (chunk) => chunks.push(chunk))',
    'process.stdin.on("end", () => {',
    '  const prompt = Buffer.concat(chunks).toString("utf8")',
    "  let text",
    "  try {",
    "    text = respond(prompt)",
    "  } catch (error) {",
    "    process.stderr.write(String(error && error.stack ? error.stack : error))",
    "    process.exit(3)",
    "  }",
    '  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")',
    '  emit({ type: "system", subtype: "init", model: "stub-claude-1" })',
    '  emit({ type: "assistant", message: { content: [{ type: "text", text }] } })',
    '  emit({ type: "result", usage: { input_tokens: 100, output_tokens: 40 } })',
    "})",
    ""
  ].join("\n")

/** The reviewer and judge replies every phase-3-to-5 stub needs. */
export const commonReplies = [
  '  if (prompt.includes("Report problems as JSON")) {',
  '    return JSON.stringify({ issues: [], summary: "clean" })',
  "  }",
  '  if (prompt.includes("spec-compliance")) {',
  "    return JSON.stringify({",
  "      scores: [",
  '        { name: "spec-compliance", score: 2, reasoning: "satisfies every rule" },',
  '        { name: "scenario-coverage", score: 2, reasoning: "every scenario exercised" }',
  "      ],",
  '      summary: "clean"',
  "    })",
  "  }"
].join("\n")

export const runFlow = (
  fixture: Fixture,
  flow: string,
  repo: string,
  extraEnv: Readonly<Record<string, string>> = {},
  task?: string
): SpawnSyncReturns<string> =>
  spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(flowsRoot, `${flow}.ts`),
      "--repo",
      repo,
      ...(task === undefined ? [] : [task])
    ],
    {
      // The launch directory is the fixture, so LLM4TS_PACK resolves there —
      // which also proves a pack works from an arbitrary working directory.
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
        LLM4TS_PACK: "packs/smoke",
        LLM4TS_CODER: "claude",
        LLM4TS_VERBOSITY: "quiet",
        ...extraEnv
      }
    }
  )

export const failureReport = (label: string, result: SpawnSyncReturns<string>): string =>
  `${label} exited ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
