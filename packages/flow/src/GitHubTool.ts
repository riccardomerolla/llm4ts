import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capabilities } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { ProcessError, type FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { guarded } from "./CapabilityGuard.ts"

export class IssueRef extends Schema.Class<IssueRef>("IssueRef")({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int
}) {
  get shortRef(): string {
    return `${this.owner}/${this.repo}#${this.number}`
  }
}

export const parseIssueRef = (input: string): IssueRef | undefined => {
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(input.trim())
  const owner = match?.[1]
  const repo = match?.[2]
  const number = Number.parseInt(match?.[3] ?? "", 10)
  return owner === undefined || repo === undefined || !Number.isInteger(number) || number <= 0
    ? undefined
    : IssueRef.make({ owner, repo, number })
}

export class Issue extends Schema.Class<Issue>("Issue")({
  title: Schema.String,
  body: Schema.String,
  author: Schema.String
}) {}

export class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  url: Schema.String
}) {
  get shortRef(): string {
    return `${this.owner}/${this.repo}#${this.number}`
  }
}

export const BuildOutcome = Schema.Literals(["Success", "Failure", "Pending", "TimedOut"])
export type BuildOutcome = typeof BuildOutcome.Type

export const parsePullRequestUrl = (url: string): PullRequest | undefined => {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+).*$/.exec(url.trim())
  const owner = match?.[1]
  const repo = match?.[2]
  const number = Number.parseInt(match?.[3] ?? "", 10)
  return owner === undefined || repo === undefined || !Number.isInteger(number)
    ? undefined
    : PullRequest.make({
        owner,
        repo,
        number,
        url: url.trim()
      })
}

export const prViewArgs = ["pr", "view", "--json", "url", "--jq", ".url"]

export const prCreateArgs = (
  title: string,
  body: string,
  base: string | undefined,
  draft: boolean
): ReadonlyArray<string> => [
  "pr",
  "create",
  "--title",
  title,
  "--body",
  body,
  ...(base === undefined ? [] : ["--base", base]),
  ...(draft ? ["--draft"] : [])
]

export const issueViewArgs = (ref: IssueRef): ReadonlyArray<string> => [
  "issue",
  "view",
  String(ref.number),
  "--repo",
  `${ref.owner}/${ref.repo}`,
  "--json",
  "title,body,author"
]

export const issueCommentArgs = (ref: IssueRef, body: string): ReadonlyArray<string> => [
  "issue",
  "comment",
  String(ref.number),
  "--repo",
  `${ref.owner}/${ref.repo}`,
  "--body",
  body
]

export const prCommentArgs = (pr: PullRequest, body: string): ReadonlyArray<string> => [
  "pr",
  "comment",
  String(pr.number),
  "--repo",
  `${pr.owner}/${pr.repo}`,
  "--body",
  body
]

export const prPatchArgs = (
  pr: PullRequest,
  title: string,
  body: string
): ReadonlyArray<string> => [
  "api",
  "--method",
  "PATCH",
  `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
  "-f",
  `title=${title}`,
  "-f",
  `body=${body}`
]

export const prChecksArgs = (pr: PullRequest): ReadonlyArray<string> => [
  "pr",
  "view",
  String(pr.number),
  "--repo",
  `${pr.owner}/${pr.repo}`,
  "--json",
  "statusCheckRollup"
]

class GhAuthor extends Schema.Class<GhAuthor>("GhAuthor")({
  login: Schema.String
}) {}

class GhIssue extends Schema.Class<GhIssue>("GhIssue")({
  title: Schema.String,
  body: Schema.String,
  author: GhAuthor
}) {}

class GhCheck extends Schema.Class<GhCheck>("GhCheck")({
  status: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String)
}) {}

class GhChecks extends Schema.Class<GhChecks>("GhChecks")({
  statusCheckRollup: Schema.Array(GhCheck).pipe(
    Schema.withConstructorDefault(Effect.succeed(Object.freeze([])))
  )
}) {}

export const parseIssue = (json: string): Effect.Effect<Issue, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GhIssue))(json).pipe(
    Effect.map(
      (issue) =>
        new Issue({
          title: issue.title,
          body: issue.body,
          author: issue.author.login
        })
    ),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "gh issue view",
        detail: `invalid issue JSON: ${String(error)}`
      })
    )
  )

export const outcomeFromChecksJson = (json: string): Effect.Effect<BuildOutcome, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GhChecks))(json).pipe(
    Effect.map((parsed) => {
      const pending = parsed.statusCheckRollup.some(
        (check) =>
          (check.status !== undefined && check.status.toUpperCase() !== "COMPLETED") ||
          ["PENDING", "EXPECTED"].includes(check.state?.toUpperCase() ?? "")
      )
      const failed = parsed.statusCheckRollup.some(
        (check) =>
          ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
            check.conclusion?.toUpperCase() ?? ""
          ) || ["FAILURE", "ERROR"].includes(check.state?.toUpperCase() ?? "")
      )
      return pending ? "Pending" : failed ? "Failure" : "Success"
    }),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "gh pr checks",
        detail: `invalid checks JSON: ${String(error)}`
      })
    )
  )

export interface GitHubToolShape {
  readonly createPr: (
    title: string,
    body: string,
    base?: string,
    draft?: boolean
  ) => Effect.Effect<PullRequest, FlowError>
  readonly readIssue: (ref: IssueRef) => Effect.Effect<Issue, FlowError>
  readonly writeIssueComment: (ref: IssueRef, body: string) => Effect.Effect<void, FlowError>
  readonly writePrComment: (pr: PullRequest, body: string) => Effect.Effect<void, FlowError>
  readonly updatePr: (
    pr: PullRequest,
    title: string,
    body: string
  ) => Effect.Effect<void, FlowError>
  readonly prChecks: (pr: PullRequest) => Effect.Effect<BuildOutcome, FlowError>
}

const output = (result: ProcessResult): string => result.stdout.join("\n").trim()

export const makeGitHubTool = (
  process: ProcessExecutorShape,
  workDir: string,
  events: FlowEventsShape
): GitHubToolShape => {
  const run = (
    args: ReadonlyArray<string>,
    allowFailure = false
  ): Effect.Effect<ProcessResult, FlowError> =>
    process.run(["gh", ...args], workDir, {}).pipe(
      Effect.mapError((error) =>
        ProcessError.make({
          message: `gh ${args.join(" ")}`,
          detail: error.message
        })
      ),
      Effect.flatMap((result) =>
        result.exitCode === 0 || allowFailure
          ? Effect.succeed(result)
          : Effect.fail(
              ProcessError.make({
                message: `gh ${args.join(" ")}`,
                detail:
                  [...result.stdout, ...result.stderr].join("\n").trim() ||
                  `exit code ${result.exitCode}`
              })
            )
      )
    )

  const read = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.GhRead, operation, events, effect)
  const write = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.GhWrite, operation, events, effect)

  const findOpenPr = run(prViewArgs, true).pipe(
    Effect.map((result) =>
      result.exitCode === 0
        ? output(result)
            .split(/\r?\n/)
            .map(parsePullRequestUrl)
            .find((item) => item !== undefined)
        : undefined
    )
  )

  return {
    createPr: (title, body, base, draft = false) =>
      write(
        "gh pr create",
        Effect.flatMap(findOpenPr, (existing) =>
          existing === undefined
            ? run(prCreateArgs(title, body, base, draft)).pipe(
                Effect.flatMap((result) => {
                  const pr = output(result)
                    .split(/\r?\n/)
                    .map(parsePullRequestUrl)
                    .find((item) => item !== undefined)
                  return pr === undefined
                    ? Effect.fail(
                        ProcessError.make({
                          message: "gh pr create",
                          detail: `could not parse a PR URL from: ${output(result)}`
                        })
                      )
                    : Effect.succeed(pr)
                })
              )
            : Effect.succeed(existing)
        )
      ),
    readIssue: (ref) =>
      read(
        "gh issue view",
        run(issueViewArgs(ref)).pipe(Effect.flatMap((result) => parseIssue(output(result))))
      ),
    writeIssueComment: (ref, body) =>
      write("gh issue comment", run(issueCommentArgs(ref, body)).pipe(Effect.asVoid)),
    writePrComment: (pr, body) =>
      write("gh pr comment", run(prCommentArgs(pr, body)).pipe(Effect.asVoid)),
    updatePr: (pr, title, body) =>
      write("gh pr edit", run(prPatchArgs(pr, title, body)).pipe(Effect.asVoid)),
    prChecks: (pr) =>
      read(
        "gh pr checks",
        run(prChecksArgs(pr)).pipe(
          Effect.flatMap((result) => outcomeFromChecksJson(output(result)))
        )
      )
  }
}
