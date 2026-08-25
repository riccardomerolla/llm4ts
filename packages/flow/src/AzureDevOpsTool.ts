import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capabilities } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { ProcessError, type FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { guarded } from "./CapabilityGuard.ts"

// Azure DevOps through the `az` CLI (ADR 0011), the sibling of GitHubTool's
// `gh` protocol: pure args builders, schema-decoded `--output json`, and
// capability guards around a ProcessExecutor. Credentials belong to the CLI
// (`az devops login`, or AZURE_DEVOPS_EXT_PAT in the process environment) —
// this module never reads, holds, or forwards a PAT, so no secret can reach
// argv, a log line, or a persisted plan.

export class AdoConfig extends Schema.Class<AdoConfig>("AdoConfig")({
  orgUrl: Schema.String,
  project: Schema.String,
  repository: Schema.String,
  // Only `az devops invoke` (the comments REST resource, which has no
  // first-class `az boards` verb) needs an explicit API version; every
  // other call is a versioned CLI command.
  apiVersion: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("7.1-preview")))
}) {}

export class WorkItem extends Schema.Class<WorkItem>("WorkItem")({
  id: Schema.Int,
  title: Schema.String,
  description: Schema.String,
  acceptanceCriteria: Schema.String,
  state: Schema.String,
  tags: Schema.Array(Schema.String),
  createdBy: Schema.String,
  changedDate: Schema.String
}) {}

export class WorkItemComment extends Schema.Class<WorkItemComment>("WorkItemComment")({
  id: Schema.Int,
  author: Schema.String,
  text: Schema.String,
  createdDate: Schema.String
}) {}

export class AdoPullRequest extends Schema.Class<AdoPullRequest>("AdoPullRequest")({
  id: Schema.Int,
  repoId: Schema.String,
  projectId: Schema.String,
  webUrl: Schema.String
}) {}

// Azure DevOps branch policies are the analogue of GitHub's check rollup.
// There is no policy status for a timed-out run, so the outcome set is the
// GitHub one minus "TimedOut".
export const PolicyOutcome = Schema.Literals(["Success", "Failure", "Pending"])
export type PolicyOutcome = typeof PolicyOutcome.Type

export const WorkItemState = Schema.Literals(["open", "closed", "all"])
export type WorkItemState = typeof WorkItemState.Type

export interface WorkItemFilter {
  readonly tags?: ReadonlyArray<string>
  readonly state?: WorkItemState
  readonly assignedTo?: string
  readonly limit?: number
}

// `refs/heads/x` and `x` both name a branch across the Azure DevOps
// surface; the CLI wants the short form, so every ref is normalized once
// on the way into argv.
export const branchName = (ref: string): string => ref.trim().replace(/^refs\/heads\//, "")

const org = (config: AdoConfig): ReadonlyArray<string> => [
  "--org",
  config.orgUrl,
  // Without this the CLI probes the working directory's git remote and
  // silently retargets another organization; a library must not guess.
  "--detect",
  "false"
]

const json = ["--output", "json"]

// ---------------------------------------------------------------------------
// Work item argv
// ---------------------------------------------------------------------------

export const workItemShowArgs = (config: AdoConfig, id: number): ReadonlyArray<string> => [
  "boards",
  "work-item",
  "show",
  "--id",
  String(id),
  ...org(config),
  ...json
]

export const fieldArgs = (fields: Readonly<Record<string, string>>): ReadonlyArray<string> => {
  const pairs = Object.entries(fields).map(([name, value]) => `${name}=${value}`)
  return pairs.length === 0 ? [] : ["--fields", ...pairs]
}

export const workItemUpdateArgs = (
  config: AdoConfig,
  id: number,
  fields: Readonly<Record<string, string>>
): ReadonlyArray<string> => [
  "boards",
  "work-item",
  "update",
  "--id",
  String(id),
  ...fieldArgs(fields),
  ...org(config),
  ...json
]

export const workItemCommentArgs = (
  config: AdoConfig,
  id: number,
  text: string
): ReadonlyArray<string> => [
  "boards",
  "work-item",
  "update",
  "--id",
  String(id),
  "--discussion",
  text,
  ...org(config),
  ...json
]

export const workItemCreateArgs = (
  config: AdoConfig,
  workItemType: string,
  title: string,
  description: string,
  tags: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "boards",
  "work-item",
  "create",
  "--title",
  title,
  "--type",
  workItemType,
  "--description",
  description,
  "--project",
  config.project,
  ...fieldArgs(tags.length === 0 ? {} : { "System.Tags": tags.join("; ") }),
  ...org(config),
  ...json
]

export const commentsArgs = (config: AdoConfig, id: number): ReadonlyArray<string> => [
  "devops",
  "invoke",
  "--area",
  "wit",
  "--resource",
  "comments",
  "--route-parameters",
  `project=${config.project}`,
  `workItemId=${String(id)}`,
  "--api-version",
  config.apiVersion,
  ...org(config),
  ...json
]

// ---------------------------------------------------------------------------
// WIQL
// ---------------------------------------------------------------------------

// WIQL string literals are single-quoted; a quote inside a value is escaped
// by doubling it. Every caller-supplied value goes through here so a tag
// like "won't fix" cannot terminate the literal and rewrite the query.
export const quoteWiql = (value: string): string => `'${value.replace(/'/g, "''")}'`

export const workItemFields: ReadonlyArray<string> = [
  "System.Id",
  "System.Title",
  "System.Description",
  "System.State",
  "System.Tags",
  "System.CreatedBy",
  "System.ChangedDate",
  "Microsoft.VSTS.Common.AcceptanceCriteria"
]

export const wiqlFor = (filter: WorkItemFilter): string => {
  const clauses = [
    "[System.TeamProject] = @project",
    ...(filter.state === "all"
      ? []
      : filter.state === "closed"
        ? ["[System.State] = 'Closed'"]
        : ["[System.State] <> 'Closed'"]),
    ...(filter.tags ?? []).map((tag) => `[System.Tags] CONTAINS ${quoteWiql(tag)}`),
    ...(filter.assignedTo === undefined
      ? []
      : [`[System.AssignedTo] = ${quoteWiql(filter.assignedTo)}`])
  ]
  const select = workItemFields.map((name) => `[${name}]`).join(", ")
  return (
    `SELECT TOP ${String(filter.limit ?? 100)} ${select} FROM WorkItems ` +
    `WHERE ${clauses.join(" AND ")} ORDER BY [System.Id] ASC`
  )
}

export const queryArgs = (config: AdoConfig, wiql: string): ReadonlyArray<string> => [
  "boards",
  "query",
  "--wiql",
  wiql,
  "--project",
  config.project,
  ...org(config),
  ...json
]

// ---------------------------------------------------------------------------
// Pull request argv
// ---------------------------------------------------------------------------

export const prCreateArgs = (
  config: AdoConfig,
  sourceRef: string,
  targetRef: string,
  title: string,
  description: string,
  draft = false
): ReadonlyArray<string> => [
  "repos",
  "pr",
  "create",
  "--repository",
  config.repository,
  "--project",
  config.project,
  "--source-branch",
  branchName(sourceRef),
  "--target-branch",
  branchName(targetRef),
  "--title",
  title,
  "--description",
  description,
  ...(draft ? ["--draft", "true"] : []),
  ...org(config),
  ...json
]

export const prListArgs = (config: AdoConfig, sourceRef?: string): ReadonlyArray<string> => [
  "repos",
  "pr",
  "list",
  "--repository",
  config.repository,
  "--project",
  config.project,
  "--status",
  "active",
  ...(sourceRef === undefined ? [] : ["--source-branch", branchName(sourceRef)]),
  ...org(config),
  ...json
]

export const prUpdateArgs = (
  config: AdoConfig,
  id: number,
  title: string,
  description: string
): ReadonlyArray<string> => [
  "repos",
  "pr",
  "update",
  "--id",
  String(id),
  "--title",
  title,
  "--description",
  description,
  ...org(config),
  ...json
]

export const prCommentArgs = (
  config: AdoConfig,
  id: number,
  text: string
): ReadonlyArray<string> => [
  "repos",
  "pr",
  "thread",
  "create",
  "--id",
  String(id),
  "--content",
  text,
  "--project",
  config.project,
  ...org(config),
  ...json
]

export const prPolicyArgs = (config: AdoConfig, id: number): ReadonlyArray<string> => [
  "repos",
  "pr",
  "policy",
  "list",
  "--id",
  String(id),
  ...org(config),
  ...json
]

export const prCompleteArgs = (
  config: AdoConfig,
  id: number,
  squash: boolean,
  deleteSourceBranch: boolean
): ReadonlyArray<string> => [
  "repos",
  "pr",
  "update",
  "--id",
  String(id),
  "--status",
  "completed",
  "--squash",
  squash ? "true" : "false",
  "--delete-source-branch",
  deleteSourceBranch ? "true" : "false",
  ...org(config),
  ...json
]

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// System.CreatedBy is an identity object on current API versions and a bare
// display string on older ones; both decode to the display name.
const Identity = Schema.Union([
  Schema.String,
  Schema.Struct({
    displayName: Schema.optionalKey(Schema.String),
    uniqueName: Schema.optionalKey(Schema.String)
  })
])

const identityName = (value: typeof Identity.Type | undefined): string =>
  value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : (value.displayName ?? value.uniqueName ?? "")

const AdoFields = Schema.Struct({
  "System.Title": Schema.optionalKey(Schema.String),
  "System.Description": Schema.optionalKey(Schema.String),
  "System.State": Schema.optionalKey(Schema.String),
  "System.Tags": Schema.optionalKey(Schema.String),
  "System.CreatedBy": Schema.optionalKey(Identity),
  "System.ChangedDate": Schema.optionalKey(Schema.String),
  "Microsoft.VSTS.Common.AcceptanceCriteria": Schema.optionalKey(Schema.String)
})

const AdoWorkItem = Schema.Struct({
  id: Schema.Int,
  fields: AdoFields
})

export const parseTags = (raw: string): ReadonlyArray<string> =>
  raw
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)

const toWorkItem = (item: typeof AdoWorkItem.Type): WorkItem =>
  WorkItem.make({
    id: item.id,
    title: item.fields["System.Title"] ?? "",
    description: item.fields["System.Description"] ?? "",
    acceptanceCriteria: item.fields["Microsoft.VSTS.Common.AcceptanceCriteria"] ?? "",
    state: item.fields["System.State"] ?? "",
    tags: parseTags(item.fields["System.Tags"] ?? ""),
    createdBy: identityName(item.fields["System.CreatedBy"]),
    changedDate: item.fields["System.ChangedDate"] ?? ""
  })

const decodeFailure =
  (message: string) =>
  (error: unknown): ProcessError =>
    ProcessError.make({ message, detail: String(error) })

export const parseWorkItem = (payload: string): Effect.Effect<WorkItem, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoWorkItem))(payload).pipe(
    Effect.map(toWorkItem),
    Effect.mapError(decodeFailure("az boards work-item show"))
  )

// `az boards query` flattens the WIQL result into a work-item array, so a
// queue poll is a single call rather than a fan-out over ids.
export const parseWorkItems = (
  payload: string
): Effect.Effect<ReadonlyArray<WorkItem>, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(AdoWorkItem)))(payload).pipe(
    Effect.map((items) => items.map(toWorkItem)),
    Effect.mapError(decodeFailure("az boards query"))
  )

export const parseWorkItemIds = (
  payload: string
): Effect.Effect<ReadonlyArray<number>, ProcessError> =>
  parseWorkItems(payload).pipe(Effect.map((items) => items.map((item) => item.id)))

const AdoComments = Schema.Struct({
  comments: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      text: Schema.optionalKey(Schema.String),
      createdBy: Schema.optionalKey(Identity),
      createdDate: Schema.optionalKey(Schema.String)
    })
  ).pipe(Schema.withConstructorDefault(Effect.succeed(Object.freeze([]))))
})

export const parseComments = (
  payload: string
): Effect.Effect<ReadonlyArray<WorkItemComment>, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoComments))(payload).pipe(
    Effect.map((parsed) =>
      parsed.comments.map((comment) =>
        WorkItemComment.make({
          id: comment.id,
          author: identityName(comment.createdBy),
          text: comment.text ?? "",
          createdDate: comment.createdDate ?? ""
        })
      )
    ),
    Effect.mapError(decodeFailure("az devops invoke wit comments"))
  )

const AdoPr = Schema.Struct({
  pullRequestId: Schema.Int,
  repository: Schema.Struct({
    id: Schema.String,
    project: Schema.Struct({ id: Schema.String })
  })
})

const toPullRequest = (config: AdoConfig, pr: typeof AdoPr.Type): AdoPullRequest =>
  AdoPullRequest.make({
    id: pr.pullRequestId,
    repoId: pr.repository.id,
    projectId: pr.repository.project.id,
    webUrl:
      `${config.orgUrl}/${config.project}/_git/` +
      `${config.repository}/pullrequest/${String(pr.pullRequestId)}`
  })

export const parsePullRequest = (
  config: AdoConfig,
  payload: string
): Effect.Effect<AdoPullRequest, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoPr))(payload).pipe(
    Effect.map((pr) => toPullRequest(config, pr)),
    Effect.mapError(decodeFailure("az repos pr"))
  )

export const parsePullRequests = (
  config: AdoConfig,
  payload: string
): Effect.Effect<ReadonlyArray<AdoPullRequest>, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(AdoPr)))(payload).pipe(
    Effect.map((prs) => prs.map((pr) => toPullRequest(config, pr))),
    Effect.mapError(decodeFailure("az repos pr list"))
  )

const AdoPolicies = Schema.Array(
  Schema.Struct({
    status: Schema.optionalKey(Schema.String)
  })
)

// Policy evaluation statuses: queued/running are still deciding, and
// rejected/broken have already decided against the PR.
export const outcomeFromPolicies = (payload: string): Effect.Effect<PolicyOutcome, ProcessError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdoPolicies))(payload).pipe(
    Effect.map((policies) => {
      const statuses = policies.map((policy) => policy.status?.toLowerCase() ?? "")
      return statuses.some((value) => ["queued", "running"].includes(value))
        ? "Pending"
        : statuses.some((value) => ["rejected", "broken"].includes(value))
          ? "Failure"
          : "Success"
    }),
    Effect.mapError(decodeFailure("az repos pr policy list"))
  )

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface AzureDevOpsToolShape {
  readonly readWorkItem: (id: number) => Effect.Effect<WorkItem, FlowError>
  readonly listWorkItems: (
    filter?: WorkItemFilter
  ) => Effect.Effect<ReadonlyArray<WorkItem>, FlowError>
  readonly wiqlIds: (query: string) => Effect.Effect<ReadonlyArray<number>, FlowError>
  readonly readComments: (id: number) => Effect.Effect<ReadonlyArray<WorkItemComment>, FlowError>
  readonly setFields: (
    id: number,
    fields: Readonly<Record<string, string>>
  ) => Effect.Effect<void, FlowError>
  readonly setState: (id: number, state: string) => Effect.Effect<void, FlowError>
  readonly setAcceptanceCriteria: (id: number, text: string) => Effect.Effect<void, FlowError>
  // Tags are one semicolon-joined field, so an edit is read-merge-write
  // rather than the add/remove verbs a label API would offer.
  readonly editTags: (
    id: number,
    add: ReadonlyArray<string>,
    remove: ReadonlyArray<string>
  ) => Effect.Effect<void, FlowError>
  readonly writeComment: (id: number, text: string) => Effect.Effect<void, FlowError>
  readonly createWorkItem: (
    workItemType: string,
    title: string,
    description: string,
    tags?: ReadonlyArray<string>
  ) => Effect.Effect<WorkItem, FlowError>
  readonly createPr: (
    sourceRef: string,
    targetRef: string,
    title: string,
    body: string,
    draft?: boolean
  ) => Effect.Effect<AdoPullRequest, FlowError>
  readonly openPrForBranch: (
    sourceRef: string
  ) => Effect.Effect<AdoPullRequest | undefined, FlowError>
  readonly updatePr: (
    pr: AdoPullRequest,
    title: string,
    body: string
  ) => Effect.Effect<void, FlowError>
  readonly writePrComment: (pr: AdoPullRequest, body: string) => Effect.Effect<void, FlowError>
  readonly prPolicies: (pr: AdoPullRequest) => Effect.Effect<PolicyOutcome, FlowError>
  readonly completePr: (
    pr: AdoPullRequest,
    squash?: boolean,
    deleteSourceBranch?: boolean
  ) => Effect.Effect<void, FlowError>
}

const output = (result: ProcessResult): string => result.stdout.join("\n").trim()

export const mergeTags = (
  current: ReadonlyArray<string>,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const removed = new Set(remove.map((tag) => tag.toLowerCase()))
  const kept = current.filter((tag) => !removed.has(tag.toLowerCase()))
  const present = new Set(kept.map((tag) => tag.toLowerCase()))
  const added = add.filter(
    (tag) => !present.has(tag.toLowerCase()) && !removed.has(tag.toLowerCase())
  )
  return [...kept, ...added]
}

export const makeAzureDevOpsTool = (
  config: AdoConfig,
  process: ProcessExecutorShape,
  workDir: string,
  events: FlowEventsShape
): AzureDevOpsToolShape => {
  const run = (args: ReadonlyArray<string>): Effect.Effect<string, FlowError> =>
    process.run(["az", ...args], workDir, {}).pipe(
      Effect.mapError((error) =>
        ProcessError.make({ message: `az ${args.join(" ")}`, detail: error.message })
      ),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(output(result))
          : Effect.fail(
              ProcessError.make({
                message: `az ${args.join(" ")}`,
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
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.AdoRead, operation, events, effect)
  const write = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(Capabilities.AdoWrite, operation, events, effect)

  const readWorkItem = (id: number): Effect.Effect<WorkItem, FlowError> =>
    read("ado readWorkItem", run(workItemShowArgs(config, id)).pipe(Effect.flatMap(parseWorkItem)))

  const setFields = (
    id: number,
    fields: Readonly<Record<string, string>>
  ): Effect.Effect<void, FlowError> =>
    write("ado setFields", run(workItemUpdateArgs(config, id, fields)).pipe(Effect.asVoid))

  const listPrs = (sourceRef?: string): Effect.Effect<ReadonlyArray<AdoPullRequest>, FlowError> =>
    run(prListArgs(config, sourceRef)).pipe(
      Effect.flatMap((payload) => parsePullRequests(config, payload))
    )

  return {
    readWorkItem,
    listWorkItems: (filter = {}) =>
      read(
        "ado listWorkItems",
        run(queryArgs(config, wiqlFor(filter))).pipe(Effect.flatMap(parseWorkItems))
      ),
    wiqlIds: (query) =>
      read("ado wiql", run(queryArgs(config, query)).pipe(Effect.flatMap(parseWorkItemIds))),
    readComments: (id) =>
      read("ado readComments", run(commentsArgs(config, id)).pipe(Effect.flatMap(parseComments))),
    setFields,
    setState: (id, state) => setFields(id, { "System.State": state }),
    setAcceptanceCriteria: (id, text) =>
      setFields(id, { "Microsoft.VSTS.Common.AcceptanceCriteria": text }),
    editTags: (id, add, remove) =>
      add.length === 0 && remove.length === 0
        ? Effect.void
        : readWorkItem(id).pipe(
            Effect.flatMap((item) => {
              const next = mergeTags(item.tags, add, remove)
              return next.length === item.tags.length &&
                next.every((tag, index) => tag === item.tags[index])
                ? Effect.void
                : setFields(id, { "System.Tags": next.join("; ") })
            })
          ),
    writeComment: (id, text) =>
      write("ado writeComment", run(workItemCommentArgs(config, id, text)).pipe(Effect.asVoid)),
    createWorkItem: (workItemType, title, description, tags = []) =>
      write(
        "ado createWorkItem",
        run(workItemCreateArgs(config, workItemType, title, description, tags)).pipe(
          Effect.flatMap(parseWorkItem)
        )
      ),
    createPr: (sourceRef, targetRef, title, body, draft = false) =>
      write(
        "ado createPr",
        // An active PR for the branch already IS the deliverable; creating a
        // second one would fail on the server and lose the first's reviews.
        Effect.flatMap(listPrs(sourceRef), (existing) => {
          const open = existing[0]
          return open !== undefined
            ? Effect.succeed(open)
            : run(prCreateArgs(config, sourceRef, targetRef, title, body, draft)).pipe(
                Effect.flatMap((payload) => parsePullRequest(config, payload))
              )
        })
      ),
    openPrForBranch: (sourceRef) =>
      read("ado listPrs", listPrs(sourceRef).pipe(Effect.map((prs) => prs[0]))),
    updatePr: (pr, title, body) =>
      write("ado updatePr", run(prUpdateArgs(config, pr.id, title, body)).pipe(Effect.asVoid)),
    writePrComment: (pr, body) =>
      write("ado writePrComment", run(prCommentArgs(config, pr.id, body)).pipe(Effect.asVoid)),
    prPolicies: (pr) =>
      read(
        "ado prPolicies",
        run(prPolicyArgs(config, pr.id)).pipe(Effect.flatMap(outcomeFromPolicies))
      ),
    completePr: (pr, squash = true, deleteSourceBranch = true) =>
      write(
        "ado completePr",
        run(prCompleteArgs(config, pr.id, squash, deleteSourceBranch)).pipe(Effect.asVoid)
      )
  }
}
