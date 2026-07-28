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
  issueCommentArgs,
  issueViewArgs,
  makeGitHubTool,
  outcomeFromChecksJson,
  parseIssue,
  parsePullRequestUrl,
  prChecksArgs,
  prCreateArgs,
  prPatchArgs
} from "@llm4ts/flow/GitHubTool"

describe("GitHub tool protocol", () => {
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
