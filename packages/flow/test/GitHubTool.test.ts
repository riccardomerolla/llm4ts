import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  IssueRef,
  PullRequest,
  RepoRef,
  issueAssignArgs,
  issueCloseArgs,
  issueCommentArgs,
  issueEditLabelsArgs,
  issueListArgs,
  issueListFields,
  issueViewArgs,
  makeGitHubTool,
  outcomeFromChecksJson,
  parseIssue,
  parseIssueList,
  parseIssueRef,
  parsePullRequestUrl,
  prChecksArgs,
  prCreateArgs,
  prPatchArgs
} from "@llm4ts/flow/GitHubTool"

describe("GitHub tool protocol", () => {
  it("parses canonical issue references", () => {
    assert.deepStrictEqual(
      parseIssueRef("owner/repo#42"),
      IssueRef.make({
        owner: "owner",
        repo: "repo",
        number: 42
      })
    )
    assert.isUndefined(parseIssueRef("not-an-issue"))
  })

  it("builds deterministic argv and parses PR URLs", () => {
    const issue = IssueRef.make({
      owner: "acme",
      repo: "widgets",
      number: 42
    })
    const pr = PullRequest.make({
      owner: "acme",
      repo: "widgets",
      number: 7,
      url: "u"
    })

    assert.deepStrictEqual(prCreateArgs("T", "B", "main", true), [
      "pr",
      "create",
      "--title",
      "T",
      "--body",
      "B",
      "--base",
      "main",
      "--draft"
    ])
    assert.deepStrictEqual(issueViewArgs(issue), [
      "issue",
      "view",
      "42",
      "--repo",
      "acme/widgets",
      "--json",
      "title,body,author"
    ])
    assert.deepStrictEqual(issueCommentArgs(issue, "hi").at(-1), "hi")
    assert.deepStrictEqual(prPatchArgs(pr, "T", "B"), [
      "api",
      "--method",
      "PATCH",
      "repos/acme/widgets/pulls/7",
      "-f",
      "title=T",
      "-f",
      "body=B"
    ])
    assert.deepStrictEqual(prChecksArgs(pr).slice(0, 3), ["pr", "view", "7"])
    assert.strictEqual(
      parsePullRequestUrl("https://github.com/acme/widgets/pull/7")?.shortRef,
      "acme/widgets#7"
    )
    assert.strictEqual(parsePullRequestUrl("not a url"), undefined)
  })

  it.effect("decodes issues and applies pending-before-failure check precedence", () =>
    Effect.gen(function* () {
      const issue = yield* parseIssue(
        '{"title":"Bug","body":"Breaks","author":{"login":"octocat"}}'
      )
      const outcome = yield* outcomeFromChecksJson(
        '{"statusCheckRollup":[' +
          '{"status":"COMPLETED","conclusion":"FAILURE"},' +
          '{"status":"IN_PROGRESS","conclusion":""}' +
          "]}"
      )

      assert.strictEqual(issue.author, "octocat")
      assert.strictEqual(outcome, "Pending")
      assert.strictEqual(yield* outcomeFromChecksJson('{"statusCheckRollup":[]}'), "Success")
    })
  )

  it("builds deterministic work-queue argv", () => {
    const repo = RepoRef.make({ owner: "acme", repo: "widgets" })
    const issue = IssueRef.make({ owner: "acme", repo: "widgets", number: 42 })

    assert.deepStrictEqual(
      issueListArgs(repo, { labels: ["factory:ready"], assignee: "bot", limit: 5 }),
      [
        "issue",
        "list",
        "--repo",
        "acme/widgets",
        "--state",
        "open",
        "--label",
        "factory:ready",
        "--assignee",
        "bot",
        "--limit",
        "5",
        "--json",
        issueListFields
      ]
    )
    assert.deepStrictEqual(issueListArgs(repo, {}).slice(4, 6), ["--state", "open"])
    assert.deepStrictEqual(issueEditLabelsArgs(issue, ["factory:wip"], ["factory:ready"]), [
      "issue",
      "edit",
      "42",
      "--repo",
      "acme/widgets",
      "--add-label",
      "factory:wip",
      "--remove-label",
      "factory:ready"
    ])
    assert.deepStrictEqual(issueAssignArgs(issue, "bot").slice(-2), ["--add-assignee", "bot"])
    assert.deepStrictEqual(issueCloseArgs(issue), [
      "issue",
      "close",
      "42",
      "--repo",
      "acme/widgets"
    ])
    assert.deepStrictEqual(issueCloseArgs(issue, "done").slice(-2), ["--comment", "done"])
  })

  it.effect("decodes issue lists and rejects malformed payloads", () =>
    Effect.gen(function* () {
      const issues = yield* parseIssueList(
        '[{"number":7,"title":"T","body":"B","author":{"login":"octocat"},' +
          '"labels":[{"name":"factory:ready"},{"name":"bug"}],' +
          '"updatedAt":"2026-07-31T00:00:00Z"}]'
      )
      const empty = yield* parseIssueList("[]")
      const invalid = yield* Effect.flip(parseIssueList('[{"number":"x"}]'))

      assert.strictEqual(issues.length, 1)
      assert.deepStrictEqual(issues[0]?.labels, ["factory:ready", "bug"])
      assert.strictEqual(issues[0]?.author, "octocat")
      assert.strictEqual(
        issues[0]?.ref(RepoRef.make({ owner: "acme", repo: "widgets" })).shortRef,
        "acme/widgets#7"
      )
      assert.deepStrictEqual(empty, [])
      assert.strictEqual(invalid._tag, "Process")
    })
  )

  it.effect("lists issues via gh, skips empty label edits, and denies writes", () =>
    Effect.gen(function* () {
      const repo = RepoRef.make({ owner: "acme", repo: "widgets" })
      const issue = IssueRef.make({ owner: "acme", repo: "widgets", number: 7 })
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["gh", ...issueListArgs(repo, { labels: ["factory:ready"] })]),
            ProcessResult.make({
              stdout: [
                '[{"number":7,"title":"T","body":"B","author":{"login":"octocat"},',
                '"labels":[{"name":"factory:ready"}],"updatedAt":"2026-07-31T00:00:00Z"}]'
              ],
              exitCode: 0
            })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const gh = makeGitHubTool(fake.executor, "/repo", events)
      const listed = yield* gh.listIssues(repo, { labels: ["factory:ready"] })
      yield* gh.editIssueLabels(issue, [], [])
      const readOnly = new Grants({
        ...allGrants,
        gh: "Read"
      })
      const denied = yield* Effect.flip(
        restricted(readOnly)(gh.editIssueLabels(issue, ["factory:wip"], []))
      )

      assert.strictEqual(listed[0]?.number, 7)
      assert.strictEqual(denied._tag, "CapabilityDenied")
      assert.strictEqual((yield* fake.recorded).length, 1)
    })
  )

  it.effect("finds-or-creates a PR and denies writes before spawning gh", () =>
    Effect.gen(function* () {
      const view = ["gh", "pr", "view", "--json", "url", "--jq", ".url"]
      const create = ["gh", "pr", "create", "--title", "Title", "--body", "Body"]
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(view),
            ProcessResult.make({
              stdout: [],
              stderr: ["no pull request"],
              exitCode: 1
            })
          ],
          [
            processCommandKey(create),
            ProcessResult.make({
              stdout: ["https://github.com/acme/widgets/pull/9"],
              exitCode: 0
            })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const gh = makeGitHubTool(fake.executor, "/repo", events)
      const created = yield* gh.createPr("Title", "Body")
      const readOnly = new Grants({
        ...allGrants,
        gh: "Read"
      })
      const denied = yield* Effect.flip(restricted(readOnly)(gh.writePrComment(created, "blocked")))

      assert.strictEqual(created.number, 9)
      assert.strictEqual(denied._tag, "CapabilityDenied")
      assert.strictEqual((yield* fake.recorded).length, 2)
    })
  )
})
