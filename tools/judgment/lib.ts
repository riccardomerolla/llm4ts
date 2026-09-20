import { execFileSync } from "node:child_process"
import {
  correctnessReviewer,
  readabilityReviewer,
  testReviewer,
  structureReviewer,
  performanceReviewer,
  securityReviewer,
  effectReviewer
} from "@llm4ts/flow/Review"
import type { Reviewer } from "@llm4ts/flow/Reviewer"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import {
  LlmJudgmentConfig,
  makeLlmJudgment,
  type LlmJudgmentHooks
} from "@llm4ts/core/judgment/LlmJudgment"
import type { JudgmentBackend } from "@llm4ts/core/judgment/Schemas"
import { defaultTypeSafeModel, makeTypeSafeJudgment } from "@llm4ts/core/judgment/TypeSafeJudgment"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  apiConnectorFromEnvironment,
  judgmentConnectorFromEnvironment,
  prepareConnector
} from "@llm4ts/runner/Connectors"
import type { FlowRunnerDependencies } from "@llm4ts/runner/FlowRunner"
import { nodeHttpClient } from "@llm4ts/runner/NodeHttpClient"

export class JudgmentToolError extends Schema.TaggedError<JudgmentToolError>()(
  "JudgmentToolError",
  {
    message: Schema.String
  }
) {}

export const backendFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): JudgmentBackend =>
  environment.LLM4TS_JUDGMENT_BACKEND?.trim().toLowerCase() === "typesafe" ? "typesafe" : "llm"

export const judgmentBackend = Effect.fn("JudgmentTool.backend")(function* (
  backend: JudgmentBackend,
  environment: Readonly<Record<string, string | undefined>>,
  root: string,
  dependencies: FlowRunnerDependencies,
  hooks: LlmJudgmentHooks = {}
) {
  if (backend === "fake") {
    return { judgment: (yield* makeFakeJudgment()).judgment, model: "deterministic defaults" }
  }
  if (backend === "typesafe") {
    // Keep the same trimming, blank-key refusal and Redacted boundary as FlowRunner.
    const key = environment.TYPESAFE_API_KEY?.trim()
    if (key === undefined || key.length === 0) {
      return yield* JudgmentToolError.make({
        message: "judgment backend 'typesafe' needs TYPESAFE_API_KEY in the environment"
      })
    }
    return {
      judgment: makeTypeSafeJudgment(
        {
          apiKey: Redacted.make(key),
          ...(hooks.onUsage === undefined ? {} : { onUsage: hooks.onUsage })
        },
        dependencies.http ?? nodeHttpClient
      ),
      model: defaultTypeSafeModel
    }
  }
  const config =
    (yield* judgmentConnectorFromEnvironment(environment)) ??
    (yield* apiConnectorFromEnvironment(environment))
  const seat = yield* dependencies.registry.resolve(prepareConnector(config, root, environment))
  return {
    judgment: makeLlmJudgment(
      seat,
      LlmJudgmentConfig.make({
        connector: config.connectorId.value,
        ...(config.model === undefined ? {} : { model: config.model })
      }),
      hooks
    ),
    model: config.model ?? "default"
  }
})

// Explicit allowlist: only presence is captured, never credential values or endpoint URLs.
const provenanceEnvironment = [
  "LLM4TS_PROVIDER",
  "LLM4TS_MODEL",
  "LLM4TS_BASE_URL",
  "LLM4TS_API_KEY",
  "LLM4TS_JUDGMENT_BACKEND",
  "LLM4TS_JUDGMENT_PROVIDER",
  "LLM4TS_JUDGMENT_MODEL",
  "LLM4TS_JUDGMENT_BASE_URL",
  "LLM4TS_JUDGMENT_API_KEY",
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY"
]
const shellWord = (value: string): string =>
  /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`

export const writeReport = Effect.fn("JudgmentTool.writeReport")(function* (options: {
  readonly markdown: string
  readonly out: string | undefined
  readonly root: string
  readonly tool: "eval" | "replay"
  readonly args: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly files: PlainFileStoreShape
  readonly commitRange?: string
  readonly dataset?: string
}) {
  let markdown = options.markdown
  const out = options.out === undefined ? undefined : resolve(options.root, options.out)
  const baselinePath =
    out === undefined ? undefined : relative(resolve(options.root, "docs/judgment/evals"), out)
  if (
    baselinePath !== undefined &&
    baselinePath !== "" &&
    baselinePath !== ".." &&
    !baselinePath.startsWith(`..${sep}`)
  ) {
    const provenance = yield* Effect.try({
      try: () => {
        const revision = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: options.root,
          encoding: "utf8"
        }).trim()
        const dirty =
          execFileSync("git", ["status", "--porcelain"], {
            cwd: options.root,
            encoding: "utf8"
          }).trim().length > 0
        return [
          "## Provenance",
          "",
          "```sh",
          `pnpm judgment:${options.tool} ${options.args.map(shellWord).join(" ")}`,
          "```",
          "",
          `- Git revision: ${revision}${dirty ? " (working tree modified)" : ""}`,
          `- Commit range: ${options.commitRange ?? "n/a (labelled dataset)"}`,
          ...(options.dataset === undefined
            ? []
            : [
                `- Dataset: ${options.dataset}`,
                `- Dataset SHA-256: ${createHash("sha256")
                  .update(readFileSync(resolve(options.root, options.dataset)))
                  .digest("hex")}`
              ]),
          "- Environment (presence only): " +
            provenanceEnvironment
              .map((name) => `${name}=${options.environment[name] === undefined ? "unset" : "set"}`)
              .join(", "),
          "- Provider, configured model and backend: see report below. Server version/start command and hardware: not captured; add before publishing a baseline.",
          "",
          ""
        ].join("\n")
      },
      catch: () => JudgmentToolError.make({ message: "Could not capture report provenance." })
    })
    markdown = provenance + markdown
  }
  if (out !== undefined) yield* options.files.writeAtomic(out, markdown)
  console.log(markdown)
})

export const lenses: ReadonlyArray<Reviewer> = [
  correctnessReviewer,
  readabilityReviewer,
  testReviewer,
  structureReviewer,
  performanceReviewer,
  securityReviewer,
  effectReviewer
]

export const argValue = (
  name: string,
  fallback: string,
  args: ReadonlyArray<string> = process.argv
): string => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

export interface Commit {
  readonly sha: string
  readonly title: string
  readonly diff: string
}

export const commits = (
  repo: string,
  commitCount: number,
  diffCap = 60000
): ReadonlyArray<Commit> => {
  const git = (...args: ReadonlyArray<string>): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return git("log", "--no-merges", `-${commitCount}`, "--format=%H%x1f%s")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", title = ""] = line.split("\x1f")
      const diff = git("show", "--format=", "--no-color", sha)
      return { sha, title, diff: diff.length > diffCap ? `${diff.slice(0, diffCap)}\n…` : diff }
    })
    .filter((commit) => commit.diff.trim().length > 0)
}
