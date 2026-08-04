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

export class RepoRef extends Schema.Class<RepoRef>("RepoRef")({
  owner: Schema.String,
  repo: Schema.String
}) {
  get slug(): string {
    return `${this.owner}/${this.repo}`
  }
}

export const IssueState = Schema.Literals(["open", "closed", "all"])
export type IssueState = typeof IssueState.Type

export interface IssueListFilter {
  readonly labels?: ReadonlyArray<string>
  readonly state?: IssueState
  readonly assignee?: string
  readonly limit?: number
}

export class IssueSummary extends Schema.Class<IssueSummary>("IssueSummary")({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  author: Schema.String,
  labels: Schema.Array(Schema.String),
  updatedAt: Schema.String
}) {
  ref(repo: RepoRef): IssueRef {
    return IssueRef.make({ owner: repo.owner, repo: repo.repo, number: this.number })
  }
}

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

export class IssueCommentRef extends Schema.Class<IssueCommentRef>("IssueCommentRef")({
  owner: Schema.String,
  repo: Schema.String,
  id: Schema.Int
}) {}

// `gh issue comment` prints the created comment's URL
// (https://host/owner/repo/issues/7#issuecomment-123456).
export const parseIssueCommentUrl = (url: string): IssueCommentRef | undefined => {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+#issuecomment-(\d+)\s*$/.exec(
    url.trim()
  )
  const owner = match?.[1]
  const repo = match?.[2]
  const id = Number.parseInt(match?.[3] ?? "", 10)
  return owner === undefined || repo === undefined || !Number.isInteger(id) || id <= 0
    ? undefined
    : IssueCommentRef.make({ owner, repo, id })
}

export const issueCommentEditArgs = (
  comment: IssueCommentRef,
  body: string
): ReadonlyArray<string> => [
  "api",
  "--method",
  "PATCH",
  `repos/${comment.owner}/${comment.repo}/issues/comments/${comment.id}`,
  "-f",
  `body=${body}`
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

export const issueListFields = "number,title,body,author,labels,updatedAt"

export const issueListArgs = (repo: RepoRef, filter: IssueListFilter): ReadonlyArray<string> => [
  "issue",
  "list",
  "--repo",
  repo.slug,
  "--state",
  filter.state ?? "open",
  ...(filter.labels ?? []).flatMap((label) => ["--label", label]),
  ...(filter.assignee === undefined ? [] : ["--assignee", filter.assignee]),
  "--limit",
  String(filter.limit ?? 100),
  "--json",
  issueListFields
]

export const issueCreateArgs = (
  repo: RepoRef,
  title: string,
  body: string,
  labels: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "issue",
  "create",
  "--repo",
  repo.slug,
  "--title",
  title,
  "--body",
  body,
  ...labels.flatMap((label) => ["--label", label])
]

export const parseIssueUrl = (url: string): IssueRef | undefined => {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/(\d+)\s*$/.exec(url.trim())
  const owner = match?.[1]
  const repo = match?.[2]
  const number = Number.parseInt(match?.[3] ?? "", 10)
  return owner === undefined || repo === undefined || !Number.isInteger(number) || number <= 0
    ? undefined
    : IssueRef.make({ owner, repo, number })
}

export const issueEditLabelsArgs = (
  ref: IssueRef,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "issue",
  "edit",
  String(ref.number),
  "--repo",
  `${ref.owner}/${ref.repo}`,
  ...add.flatMap((label) => ["--add-label", label]),
  ...remove.flatMap((label) => ["--remove-label", label])
]

export const issueAssignArgs = (ref: IssueRef, login: string): ReadonlyArray<string> => [
  "issue",
  "edit",
  String(ref.number),
  "--repo",
  `${ref.owner}/${ref.repo}`,
  "--add-assignee",
  login
]

export const issueCloseArgs = (ref: IssueRef, comment?: string): ReadonlyArray<string> => [
  "issue",
  "close",
  String(ref.number),
  "--repo",
  `${ref.owner}/${ref.repo}`,
  ...(comment === undefined ? [] : ["--comment", comment])
]

export const MergeMethod = Schema.Literals(["squash", "merge", "rebase"])
export type MergeMethod = typeof MergeMethod.Type

export const prMergeArgs = (
  pr: PullRequest,
  method: MergeMethod,
  deleteBranch: boolean
): ReadonlyArray<string> => [
  "pr",
  "merge",
  String(pr.number),
  "--repo",
  `${pr.owner}/${pr.repo}`,
  `--${method}`,
  ...(deleteBranch ? ["--delete-branch"] : [])
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

class GhLabel extends Schema.Class<GhLabel>("GhLabel")({
  name: Schema.String
}) {}

class GhIssueSummary extends Schema.Class<GhIssueSummary>("GhIssueSummary")({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  author: GhAuthor,
  labels: Schema.Array(GhLabel).pipe(
    Schema.withConstructorDefault(Effect.succeed(Object.freeze([])))
  ),
  updatedAt: Schema.String
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

export const parseIssueList = (
  json: string
): Effect.Effect<ReadonlyArray<IssueSummary>, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GhIssueSummary)))(json).pipe(
    Effect.map((issues) =>
      issues.map(
        (issue) =>
          new IssueSummary({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            author: issue.author.login,
            labels: issue.labels.map((label) => label.name),
            updatedAt: issue.updatedAt
          })
      )
    ),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "gh issue list",
        detail: `invalid issue list JSON: ${String(error)}`
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
  // Returns the created comment's reference when the gh output carries it
  // (undefined otherwise), so callers can edit the comment later — e.g. a
  // plan checklist kept up to date as tasks complete.
  readonly writeIssueComment: (
    ref: IssueRef,
    body: string
  ) => Effect.Effect<IssueCommentRef | undefined, FlowError>
  readonly editIssueComment: (
    comment: IssueCommentRef,
    body: string
  ) => Effect.Effect<void, FlowError>
  readonly writePrComment: (pr: PullRequest, body: string) => Effect.Effect<void, FlowError>
  readonly updatePr: (
    pr: PullRequest,
    title: string,
    body: string
  ) => Effect.Effect<void, FlowError>
  readonly prChecks: (pr: PullRequest) => Effect.Effect<BuildOutcome, FlowError>
  // The open PR whose head is the working directory's current branch,
  // if any — the lookup a consumer needs before acting on "its" PR.
  readonly viewOpenPr: Effect.Effect<PullRequest | undefined, FlowError>
  readonly mergePr: (
    pr: PullRequest,
    method?: MergeMethod,
    deleteBranch?: boolean
  ) => Effect.Effect<void, FlowError>
  readonly listIssues: (
    repo: RepoRef,
    filter?: IssueListFilter
  ) => Effect.Effect<ReadonlyArray<IssueSummary>, FlowError>
  readonly createIssue: (
    repo: RepoRef,
    title: string,
    body: string,
    labels?: ReadonlyArray<string>
  ) => Effect.Effect<IssueRef, FlowError>
  readonly editIssueLabels: (
    ref: IssueRef,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>
  ) => Effect.Effect<void, FlowError>
  readonly assignIssue: (ref: IssueRef, login: string) => Effect.Effect<void, FlowError>
  readonly closeIssue: (ref: IssueRef, comment?: string) => Effect.Effect<void, FlowError>
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
      write(
        "gh issue comment",
        run(issueCommentArgs(ref, body)).pipe(
          Effect.map((result) =>
            output(result)
              .split(/\r?\n/)
              .map(parseIssueCommentUrl)
              .find((item) => item !== undefined)
          )
        )
      ),
    editIssueComment: (comment, body) =>
      write("gh issue comment edit", run(issueCommentEditArgs(comment, body)).pipe(Effect.asVoid)),
    writePrComment: (pr, body) =>
      write("gh pr comment", run(prCommentArgs(pr, body)).pipe(Effect.asVoid)),
    updatePr: (pr, title, body) =>
      write("gh pr edit", run(prPatchArgs(pr, title, body)).pipe(Effect.asVoid)),
    viewOpenPr: read("gh pr view", findOpenPr),
    mergePr: (pr, method = "squash", deleteBranch = true) =>
      write("gh pr merge", run(prMergeArgs(pr, method, deleteBranch)).pipe(Effect.asVoid)),
    prChecks: (pr) =>
      read(
        "gh pr checks",
        run(prChecksArgs(pr)).pipe(
          Effect.flatMap((result) => outcomeFromChecksJson(output(result)))
        )
      ),
    listIssues: (repo, filter = {}) =>
      read(
        "gh issue list",
        run(issueListArgs(repo, filter)).pipe(
          Effect.flatMap((result) => parseIssueList(output(result)))
        )
      ),
    createIssue: (repo, title, body, labels = []) =>
      write(
        "gh issue create",
        run(issueCreateArgs(repo, title, body, labels)).pipe(
          Effect.flatMap((result) => {
            const ref = output(result)
              .split(/\r?\n/)
              .map(parseIssueUrl)
              .find((item) => item !== undefined)
            return ref === undefined
              ? Effect.fail(
                  ProcessError.make({
                    message: "gh issue create",
                    detail: `could not parse an issue URL from: ${output(result)}`
                  })
                )
              : Effect.succeed(ref)
          })
        )
      ),
    editIssueLabels: (ref, add, remove) =>
      add.length === 0 && remove.length === 0
        ? Effect.void
        : write("gh issue edit", run(issueEditLabelsArgs(ref, add, remove)).pipe(Effect.asVoid)),
    assignIssue: (ref, login) =>
      write("gh issue edit", run(issueAssignArgs(ref, login)).pipe(Effect.asVoid)),
    closeIssue: (ref, comment) =>
      write("gh issue close", run(issueCloseArgs(ref, comment)).pipe(Effect.asVoid))
  }
}
