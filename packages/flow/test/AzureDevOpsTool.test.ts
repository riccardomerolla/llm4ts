import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import {
  AdoConfig,
  AdoPullRequest,
  branchName,
  commentsArgs,
  makeAzureDevOpsTool,
  mergeTags,
  outcomeFromPolicies,
  parseComments,
  parsePullRequests,
  parseWorkItem,
  parseWorkItemIds,
  prCompleteArgs,
  prCreateArgs,
  prListArgs,
  prPolicyArgs,
  queryArgs,
  quoteWiql,
  wiqlFor,
  workItemCommentArgs,
  workItemCreateArgs,
  workItemShowArgs,
  workItemUpdateArgs
} from "@llm4ts/flow/AzureDevOpsTool"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"

const config = AdoConfig.make({
  orgUrl: "https://dev.azure.com/acme",
  project: "project",
  repository: "repo"
})

const ok = (stdout: string): ProcessResult => ProcessResult.make({ stdout: [stdout], exitCode: 0 })

const workItemJson = (overrides: Readonly<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    id: 7,
    fields: {
      "System.Title": "Bug",
      "System.Description": "Breaks",
      "Microsoft.VSTS.Common.AcceptanceCriteria": "Must work",
      "System.State": "Active",
      "System.Tags": "one; two",
      "System.CreatedBy": { displayName: "Ada" },
      "System.ChangedDate": "2026-08-01T00:00:00Z",
      ...overrides
    }
  })

const prJson = JSON.stringify({
  pullRequestId: 9,
  repository: { id: "repo-id", project: { id: "project-id" } }
})

describe("Azure DevOps CLI protocol", () => {
  it("builds deterministic az argv that never carries a credential", () => {
    assert.deepStrictEqual(workItemShowArgs(config, 7), [
      "boards",
      "work-item",
      "show",
      "--id",
      "7",
      "--org",
      "https://dev.azure.com/acme",
      "--detect",
      "false",
      "--output",
      "json"
    ])
    assert.deepStrictEqual(
      workItemUpdateArgs(config, 7, { "System.State": "Active" }).slice(0, 7),
      ["boards", "work-item", "update", "--id", "7", "--fields", "System.State=Active"]
    )
    assert.deepStrictEqual(workItemCommentArgs(config, 7, "hello").slice(5, 7), [
      "--discussion",
      "hello"
    ])
    assert.deepStrictEqual(workItemCreateArgs(config, "Task", "T", "D", ["a", "b"]).slice(9, 13), [
      "--project",
      "project",
      "--fields",
      "System.Tags=a; b"
    ])
    // Refs arrive in either form; the CLI only accepts the short one.
    assert.deepStrictEqual(
      prCreateArgs(config, "refs/heads/feature", "refs/heads/main", "T", "B").slice(7, 11),
      ["--source-branch", "feature", "--target-branch", "main"]
    )
    assert.deepStrictEqual(prCreateArgs(config, "feature", "main", "T", "B", true).slice(15, 17), [
      "--draft",
      "true"
    ])
    assert.deepStrictEqual(prListArgs(config, "refs/heads/feature").slice(7, 11), [
      "--status",
      "active",
      "--source-branch",
      "feature"
    ])
    assert.deepStrictEqual(prCompleteArgs(config, 9, true, false).slice(5, 11), [
      "--status",
      "completed",
      "--squash",
      "true",
      "--delete-source-branch",
      "false"
    ])
    assert.deepStrictEqual(prPolicyArgs(config, 9).slice(0, 5), [
      "repos",
      "pr",
      "policy",
      "list",
      "--id"
    ])
    assert.deepStrictEqual(commentsArgs(config, 7).slice(0, 8), [
      "devops",
      "invoke",
      "--area",
      "wit",
      "--resource",
      "comments",
      "--route-parameters",
      "project=project"
    ])
    assert.strictEqual(branchName("refs/heads/factory/issue-1"), "factory/issue-1")
    assert.strictEqual(branchName(" main "), "main")
  })

  it("escapes WIQL literals so a tag cannot rewrite the query", () => {
    assert.strictEqual(quoteWiql("won't fix"), "'won''t fix'")
    const wiql = wiqlFor({ tags: ["factory:ready"], limit: 5, assignedTo: "bot" })
    assert.match(wiql, /SELECT TOP 5 /)
    assert.match(wiql, /\[System\.State\] <> 'Closed'/)
    assert.match(wiql, /\[System\.Tags\] CONTAINS 'factory:ready'/)
    assert.match(wiql, /\[System\.AssignedTo\] = 'bot'/)
    assert.match(wiqlFor({ state: "closed" }), /\[System\.State\] = 'Closed'/)
    // "all" drops the state predicate; System.State stays in the SELECT list.
    assert.notMatch(wiqlFor({ state: "all" }), /\[System\.State\] (=|<>)/)
    // An injected quote is doubled, so the literal still closes where it should.
    assert.match(wiqlFor({ tags: ["a' OR 1=1 --"] }), /'a'' OR 1=1 --'/)
    assert.deepStrictEqual(queryArgs(config, "SELECT 1").slice(0, 5), [
      "boards",
      "query",
      "--wiql",
      "SELECT 1",
      "--project"
    ])
  })

  it.effect("parses az --output json payloads", () =>
    Effect.gen(function* () {
      const item = yield* parseWorkItem(workItemJson())
      const ids = yield* parseWorkItemIds(`[${workItemJson()},${workItemJson()}]`)
      const prs = yield* parsePullRequests(config, `[${prJson}]`)
      const comments = yield* parseComments(
        JSON.stringify({
          comments: [{ id: 1, text: "hi", createdBy: "Grace", createdDate: "2026-08-02T00:00:00Z" }]
        })
      )

      assert.strictEqual(item.title, "Bug")
      assert.deepStrictEqual(item.tags, ["one", "two"])
      assert.strictEqual(item.createdBy, "Ada")
      assert.strictEqual(item.acceptanceCriteria, "Must work")
      assert.deepStrictEqual(ids, [7, 7])
      assert.strictEqual(prs[0]?.id, 9)
      assert.match(prs[0]?.webUrl ?? "", /pullrequest\/9/)
      assert.strictEqual(comments[0]?.author, "Grace")
      // A bare identity string is as valid as an identity object.
      const legacy = yield* parseWorkItem(workItemJson({ "System.CreatedBy": "Linus" }))
      assert.strictEqual(legacy.createdBy, "Linus")
    })
  )

  it.effect("maps branch-policy statuses onto a build outcome", () =>
    Effect.gen(function* () {
      const pending = yield* outcomeFromPolicies(
        '[{"status":"approved"},{"status":"queued"},{"status":"rejected"}]'
      )
      const failure = yield* outcomeFromPolicies('[{"status":"approved"},{"status":"broken"}]')

      assert.strictEqual(pending, "Pending")
      assert.strictEqual(failure, "Failure")
      assert.strictEqual(yield* outcomeFromPolicies("[]"), "Success")
      assert.strictEqual(
        yield* outcomeFromPolicies('[{"status":"approved"},{"status":"notApplicable"}]'),
        "Success"
      )
    })
  )

  it("merges tags case-insensitively because Azure DevOps tags are", () => {
    assert.deepStrictEqual(mergeTags(["ready", "epic"], ["wip"], ["Ready"]), ["epic", "wip"])
    assert.deepStrictEqual(mergeTags(["wip"], ["WIP"], []), ["wip"])
    assert.deepStrictEqual(mergeTags([], [], []), [])
  })

  it.effect("drives the CLI through the process fake and enforces read/write separation", () =>
    Effect.gen(function* () {
      const responses = new Map<string, ProcessResult>([
        [processCommandKey(["az", ...workItemShowArgs(config, 7)]), ok(workItemJson())],
        [
          processCommandKey(["az", ...workItemUpdateArgs(config, 7, { "System.State": "Active" })]),
          ok(workItemJson({ "System.State": "Active" }))
        ],
        [
          processCommandKey([
            "az",
            ...workItemUpdateArgs(config, 7, { "System.Tags": "one; wip" })
          ]),
          ok(workItemJson({ "System.Tags": "one; wip" }))
        ],
        [processCommandKey(["az", ...prListArgs(config, "feature")]), ok("[]")],
        [
          processCommandKey([
            "az",
            ...prCreateArgs(config, "refs/heads/feature", "refs/heads/main", "Title", "Body")
          ]),
          ok(prJson)
        ],
        [
          processCommandKey(["az", ...queryArgs(config, wiqlFor({ tags: ["factory:ready"] }))]),
          ok(`[${workItemJson()}]`)
        ]
      ])
      const fake = yield* makeFakeProcessExecutor({ responses })
      const events = yield* makeCollectingFlowEvents
      const ado = makeAzureDevOpsTool(config, fake.executor, "/work", events)

      const item = yield* ado.readWorkItem(7)
      const queue = yield* ado.listWorkItems({ tags: ["factory:ready"] })
      const pr = yield* ado.createPr("refs/heads/feature", "refs/heads/main", "Title", "Body")
      yield* ado.setState(7, "Active")
      // "two" goes, "wip" arrives, "one" stays — a single read-merge-write.
      yield* ado.editTags(7, ["wip"], ["two"])
      const readOnly = new Grants({ ...allGrants, ado: "Read" })
      const denied = yield* Effect.flip(restricted(readOnly)(ado.setState(7, "Active")))
      const invocations = yield* fake.recorded

      assert.strictEqual(item.id, 7)
      assert.strictEqual(queue.length, 1)
      assert.strictEqual(pr.id, 9)
      assert.match(pr.webUrl, /pullrequest\/9/)
      assert.strictEqual(denied._tag, "CapabilityDenied")
      assert.isTrue(invocations.every((invocation) => invocation.argv[0] === "az"))
      // The PAT lives in the CLI's own auth store: no argv, and no
      // environment forwarded from this module, can carry one.
      assert.isTrue(invocations.every((invocation) => !invocation.argv.includes("--token")))
      assert.isTrue(invocations.every((invocation) => Object.keys(invocation.envVars).length === 0))
      assert.notMatch(JSON.stringify(config), /token|pat/i)
    })
  )

  it.effect("reuses an active pull request instead of opening a second one", () =>
    Effect.gen(function* () {
      const responses = new Map<string, ProcessResult>([
        [processCommandKey(["az", ...prListArgs(config, "feature")]), ok(`[${prJson}]`)]
      ])
      const fake = yield* makeFakeProcessExecutor({ responses })
      const events = yield* makeCollectingFlowEvents
      const ado = makeAzureDevOpsTool(config, fake.executor, "/work", events)

      const pr = yield* ado.createPr("feature", "main", "Title", "Body")
      const open = yield* ado.openPrForBranch("feature")
      const invocations = yield* fake.recorded

      assert.strictEqual(pr.id, 9)
      assert.strictEqual(open?.id, 9)
      // No `pr create` was attempted — the fake has no response for one.
      assert.isTrue(invocations.every((invocation) => !invocation.argv.includes("create")))
    })
  )

  it.effect("surfaces a non-zero az exit as a typed process failure", () =>
    Effect.gen(function* () {
      const responses = new Map<string, ProcessResult>([
        [
          processCommandKey(["az", ...workItemShowArgs(config, 7)]),
          ProcessResult.make({
            stdout: [],
            exitCode: 1,
            stderr: ["TF401232: Work item 7 does not exist"]
          })
        ]
      ])
      const fake = yield* makeFakeProcessExecutor({ responses })
      const events = yield* makeCollectingFlowEvents
      const ado = makeAzureDevOpsTool(config, fake.executor, "/work", events)

      const error = yield* Effect.flip(ado.readWorkItem(7))

      assert.strictEqual(error._tag, "Process")
      assert.match(String("detail" in error ? error.detail : ""), /TF401232/)
    })
  )

  it("keeps a pull request reference addressable", () => {
    const pr = AdoPullRequest.make({
      id: 9,
      repoId: "repo-id",
      projectId: "project-id",
      webUrl: "https://dev.azure.com/acme/project/_git/repo/pullrequest/9"
    })
    assert.strictEqual(pr.id, 9)
    assert.deepStrictEqual(prPolicyArgs(config, pr.id).slice(4, 6), ["--id", "9"])
  })
})
