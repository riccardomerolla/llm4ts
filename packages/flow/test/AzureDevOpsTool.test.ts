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
  GitArtifact,
  artifactKindOfName,
  artifactLinkName,
  artifactUri,
  branchName,
  commentsArgs,
  makeAzureDevOpsTool,
  mergeTags,
  outcomeFromPolicies,
  parseComments,
  parseDevelopmentLinks,
  parsePullRequests,
  parseRepository,
  parseWorkItem,
  parseWorkItemIds,
  parseWorkItemLinks,
  parseWorkItems,
  linkKindOfReference,
  linkReferenceName,
  workItemIdOfUrl,
  workItemLinkArgs,
  prCompleteArgs,
  prCreateArgs,
  prListArgs,
  prPolicyArgs,
  parseArtifactUri,
  queryArgs,
  relationAddArgs,
  repositoryShowArgs,
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

const workItemJson = (overrides: Readonly<Record<string, unknown>> = {}, id = 7): string =>
  JSON.stringify({
    id,
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

  it.effect("reads the hierarchy and dependency links a board actually holds", () =>
    Effect.gen(function* () {
      // Azure DevOps holds "part of" and "waits for" as first-class links.
      // A `Parent: #12` line in a description says the same thing to a
      // reader and nothing at all to the backlog tree or a query.
      const payload = JSON.stringify({
        id: 7,
        relations: [
          {
            rel: "System.LinkTypes.Hierarchy-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/12"
          },
          {
            rel: "System.LinkTypes.Dependency-Reverse",
            url: "https://dev.azure.com/acme/_apis/wit/workItems/5"
          },
          // Artifact links and hyperlinks share the array; they belong to
          // developmentLinks, and are skipped here rather than half-read.
          {
            rel: "ArtifactLink",
            url: "vstfs:///Git/Ref/p%2Fr%2FGBmain",
            attributes: { name: "Branch" }
          },
          { rel: "Hyperlink", url: "https://example.com/spec" }
        ]
      })

      const links = yield* parseWorkItemLinks(payload)

      assert.deepStrictEqual(
        links.map((link) => [link.kind, link.id]),
        [
          ["Parent", 12],
          ["Predecessor", 5]
        ]
      )
      // Never touched: the whole relations key is absent, not empty.
      assert.deepStrictEqual([...(yield* parseWorkItemLinks('{"id":7}'))], [])
    })
  )

  it("names links the way Azure DevOps and the CLI each expect", () => {
    // Forward points away from the primary end: a parent's link to its
    // child is Hierarchy-Forward, so the child's link back is Reverse.
    assert.strictEqual(linkReferenceName("Parent"), "System.LinkTypes.Hierarchy-Reverse")
    assert.strictEqual(linkReferenceName("Child"), "System.LinkTypes.Hierarchy-Forward")
    // An item's Predecessor is the one it waits for — "blocked by".
    assert.strictEqual(linkReferenceName("Predecessor"), "System.LinkTypes.Dependency-Reverse")
    assert.strictEqual(linkKindOfReference("System.LinkTypes.Related"), "Related")
    assert.isUndefined(linkKindOfReference("ArtifactLink"))

    // The id is the url's last segment, whatever the organization's host.
    assert.strictEqual(workItemIdOfUrl("https://dev.azure.com/a/_apis/wit/workItems/91"), 91)
    assert.strictEqual(workItemIdOfUrl("https://tfs.local/tfs/c/_apis/wit/workitems/4"), 4)
    assert.isUndefined(workItemIdOfUrl("vstfs:///Git/Ref/p%2Fr%2FGBmain"))

    // A work item link takes --target-id; an artifact link takes the
    // --target-url of a vstfs: URI, and confusing the two is silent.
    assert.deepStrictEqual(workItemLinkArgs(config, 7, "Predecessor", 5).slice(0, 9), [
      "boards",
      "work-item",
      "relation",
      "add",
      "--id",
      "7",
      "--relation-type",
      "predecessor",
      "--target-id"
    ])
    assert.include(
      relationAddArgs(
        config,
        7,
        GitArtifact.make({ kind: "Branch", projectId: "p", repositoryId: "r", value: "main" })
      ),
      "--target-url"
    )
  })

  it("builds a query WIQL's grammar accepts", () => {
    // WIQL reads like SQL and is not SQL: SELECT / FROM / WHERE / ORDER BY /
    // ASOF is the whole of it. A `SELECT TOP n` — the obvious way to write a
    // row cap — leaves the SELECT list unparseable, so the server never
    // reaches FROM and rejects the query with "TF51006: the query statement
    // is missing a FROM clause". The cap belongs to the REST `$top`
    // parameter, which `az boards query` gives no way to send.
    const wiql = wiqlFor({ tags: ["factory:ready"], limit: 5 })

    assert.notMatch(wiql, /\bTOP\b/i)
    assert.match(wiql, /^SELECT \[System\.Id\], /)
    assert.match(wiql, / FROM WorkItems WHERE /)
    assert.match(wiql, / ORDER BY \[System\.Id\] ASC$/)
  })

  it.effect("reads an empty board as an empty queue", () =>
    Effect.gen(function* () {
      // The Azure CLI prints NOTHING for a command that returns None, and
      // `az boards query` returns None exactly when the WIQL matches no
      // work items. So an idle queue arrives as empty stdout with exit
      // code 0 — not `[]` — and decoding it as JSON fails with "Unexpected
      // end of JSON input". A board with nothing on it is the ordinary
      // case, not an error.
      const items = yield* parseWorkItems("")
      const alsoEmpty = yield* parseWorkItems("   \n")
      const ids = yield* parseWorkItemIds("")

      assert.deepStrictEqual(items, [])
      assert.deepStrictEqual(alsoEmpty, [])
      assert.deepStrictEqual(ids, [])

      // Malformed output is still an error: only emptiness is "no rows".
      const broken = yield* Effect.flip(parseWorkItems("[{"))
      assert.strictEqual(broken._tag, "Process")
    })
  )

  it.effect("applies the row limit to the answer instead", () =>
    Effect.gen(function* () {
      const items = [1, 2, 3, 4].map((id) => workItemJson({}, id)).join(",")
      const responses = new Map([
        [processCommandKey(["az", ...queryArgs(config, wiqlFor({ limit: 2 }))]), ok(`[${items}]`)]
      ])
      const fake = yield* makeFakeProcessExecutor({ responses })
      const events = yield* makeCollectingFlowEvents
      const ado = makeAzureDevOpsTool(config, fake.executor, "/work", events)

      const page = yield* ado.listWorkItems({ limit: 2 })

      // ORDER BY [System.Id] ASC makes the prefix deterministic, so this is
      // the same answer TOP would have given had WIQL had one.
      assert.deepStrictEqual(
        page.map((item) => item.id),
        [1, 2]
      )
    })
  )

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

describe("Azure DevOps development links", () => {
  const branch = GitArtifact.make({
    kind: "Branch",
    projectId: "p-guid",
    repositoryId: "r-guid",
    value: "factory/item-7"
  })

  it("round-trips vstfs artifact URIs, slashes in branch names included", () => {
    // The project/repo/value triple is ONE encoded segment, which is what
    // lets `factory/item-7` keep its slash without splitting the URI.
    assert.strictEqual(artifactUri(branch), "vstfs:///Git/Ref/p-guid%2Fr-guid%2FGBfactory%2Fitem-7")
    assert.deepStrictEqual(parseArtifactUri(artifactUri(branch)), branch)

    const pr = GitArtifact.make({
      kind: "PullRequest",
      projectId: "p-guid",
      repositoryId: "r-guid",
      value: "42"
    })
    assert.strictEqual(artifactUri(pr), "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F42")
    assert.deepStrictEqual(parseArtifactUri(artifactUri(pr)), pr)

    const commit = GitArtifact.make({
      kind: "Commit",
      projectId: "p-guid",
      repositoryId: "r-guid",
      value: "abc123"
    })
    assert.deepStrictEqual(parseArtifactUri(artifactUri(commit)), commit)
  })

  it("refuses URIs it cannot act on instead of guessing", () => {
    assert.isUndefined(parseArtifactUri("vstfs:///Build/Build/99"))
    assert.isUndefined(parseArtifactUri("https://example.com/branch"))
    assert.isUndefined(parseArtifactUri("vstfs:///Git/Ref/p-guid%2Fr-guid"))
    // A malformed percent escape is a bad link, not a thrown URIError.
    assert.isUndefined(parseArtifactUri("vstfs:///Git/Ref/%E0%A4%A"))
  })

  it("names links the way the CLI and the REST payloads do", () => {
    assert.strictEqual(artifactLinkName("PullRequest"), "Pull Request")
    assert.strictEqual(artifactLinkName("Commit"), "Fixed in Commit")
    assert.strictEqual(artifactKindOfName("pull request"), "PullRequest")
    assert.strictEqual(artifactKindOfName("Branch"), "Branch")
    assert.isUndefined(artifactKindOfName("Integrated in build"))
    assert.deepStrictEqual(relationAddArgs(config, 7, branch).slice(4, 10), [
      "--id",
      "7",
      "--relation-type",
      "Branch",
      "--target-url",
      artifactUri(branch)
    ])
    assert.deepStrictEqual(workItemShowArgs(config, 7, "relations").slice(5, 7), [
      "--expand",
      "relations"
    ])
    assert.deepStrictEqual(repositoryShowArgs(config, "widgets").slice(0, 5), [
      "repos",
      "show",
      "--repository",
      "widgets",
      "--project"
    ])
  })

  it.effect("reads the Development section and ignores what it cannot use", () =>
    Effect.gen(function* () {
      const links = yield* parseDevelopmentLinks(
        JSON.stringify({
          id: 7,
          fields: {},
          relations: [
            { rel: "ArtifactLink", url: artifactUri(branch), attributes: { name: "Branch" } },
            {
              rel: "ArtifactLink",
              url: "vstfs:///Git/PullRequestId/p-guid%2Fr-guid%2F42",
              attributes: { name: "Pull Request" }
            },
            // A build link is a Development link too, but not a git one.
            {
              rel: "ArtifactLink",
              url: "vstfs:///Build/Build/99",
              attributes: { name: "Integrated in build" }
            },
            // Hierarchy relations are not Development links at all.
            { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://…/workItems/1" }
          ]
        })
      )

      assert.deepStrictEqual(
        links.map((link) => `${link.kind}:${link.value}`),
        ["Branch:factory/item-7", "PullRequest:42"]
      )
      // No Development section yet is the normal state, not a failure.
      assert.deepStrictEqual([...(yield* parseDevelopmentLinks('{"id":7,"fields":{}}'))], [])
    })
  )

  it.effect("resolves the GUIDs an artifact link cannot be built without", () =>
    Effect.gen(function* () {
      const repository = yield* parseRepository(
        JSON.stringify({
          id: "r-guid",
          name: "widgets",
          project: { id: "p-guid", name: "acme" },
          defaultBranch: "refs/heads/main",
          webUrl: "https://dev.azure.com/acme/acme/_git/widgets"
        })
      )

      assert.strictEqual(repository.id, "r-guid")
      assert.strictEqual(repository.projectId, "p-guid")
      // Reported as a full ref by the CLI; callers branch by short name.
      assert.strictEqual(repository.defaultBranch, "main")

      const sparse = yield* parseRepository('{"id":"r","name":"n","project":{"id":"p"}}')
      assert.strictEqual(sparse.defaultBranch, "")
      assert.strictEqual(sparse.projectName, "")
    })
  )

  it.effect("links a branch and a pull request through the CLI, under the write guard", () =>
    Effect.gen(function* () {
      const responses = new Map<string, ProcessResult>([
        [
          processCommandKey(["az", ...workItemShowArgs(config, 7, "relations")]),
          ok(JSON.stringify({ id: 7, fields: {}, relations: [] }))
        ],
        [processCommandKey(["az", ...relationAddArgs(config, 7, branch)]), ok("{}")],
        [
          processCommandKey(["az", ...repositoryShowArgs(config, "repo")]),
          ok(
            JSON.stringify({
              id: "r-guid",
              name: "repo",
              project: { id: "p-guid", name: "project" },
              defaultBranch: "refs/heads/main"
            })
          )
        ]
      ])
      const fake = yield* makeFakeProcessExecutor({ responses })
      const events = yield* makeCollectingFlowEvents
      const ado = makeAzureDevOpsTool(config, fake.executor, "/work", events)

      assert.deepStrictEqual([...(yield* ado.developmentLinks(7))], [])
      const repository = yield* ado.repository()
      yield* ado.linkArtifact(7, branch)

      const readOnly = new Grants({ ...allGrants, ado: "Read" })
      const denied = yield* Effect.flip(restricted(readOnly)(ado.linkArtifact(7, branch)))

      assert.strictEqual(repository.id, "r-guid")
      assert.strictEqual(denied._tag, "CapabilityDenied")
      const invocations = yield* fake.recorded
      assert.isTrue(invocations.some((invocation) => invocation.argv.includes("--target-url")))
    })
  )
})
