import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import { makeRecordingHttpClient } from "@llm4ts/core/HttpClient"
import {
  AdoConfig,
  authorizationHeader,
  createPullRequestRequest,
  makeAzureDevOpsTool,
  parseWiqlIds,
  parseWorkItem,
  setFieldsRequest
} from "@llm4ts/flow/AzureDevOpsTool"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"

const config = AdoConfig.make({
  orgUrl: "https://dev.azure.com/acme",
  project: "project",
  repository: "repo",
  pat: Redacted.make("token")
})

describe("Azure DevOps tool", () => {
  it.effect("builds native requests and parses work item/WIQL payloads", () =>
    Effect.gen(function* () {
      const patch = setFieldsRequest(config, 7, {
        "System.State": "Active"
      })
      const pr = createPullRequestRequest(
        config,
        "refs/heads/feature",
        "refs/heads/main",
        "Title",
        "Body"
      )
      const item = yield* parseWorkItem(
        JSON.stringify({
          id: 7,
          fields: {
            "System.Title": "Bug",
            "System.Description": "Breaks",
            "Microsoft.VSTS.Common.AcceptanceCriteria": "Must work",
            "System.State": "Active",
            "System.Tags": "one; two"
          }
        })
      )
      const ids = yield* parseWiqlIds('{"workItems":[{"id":1},{"id":2}]}')

      assert.match(patch.url, /workitems\/7/)
      assert.strictEqual(patch.contentType, "application/json-patch+json")
      assert.match(patch.body ?? "", /System.State/)
      assert.match(pr.url, /pullrequests/)
      assert.strictEqual(item.title, "Bug")
      assert.deepStrictEqual(item.tags, ["one", "two"])
      assert.deepStrictEqual(ids, [1, 2])
      assert.strictEqual(authorizationHeader(config).Authorization, "Basic OnRva2Vu")
      assert.notMatch(JSON.stringify(config), /token/)
    })
  )

  it.effect("uses mocked HTTP fixtures and enforces read/write separation before transport", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient((request) => {
        if (request.url.includes("/workitems/7?")) {
          return Effect.succeed(
            JSON.stringify({
              id: 7,
              fields: {
                "System.Title": "Bug",
                "System.State": "New"
              }
            })
          )
        }
        if (request.url.includes("/pullrequests?")) {
          return Effect.succeed(
            JSON.stringify({
              pullRequestId: 9,
              repository: {
                id: "repo-id",
                project: { id: "project-id" }
              }
            })
          )
        }
        return Effect.succeed("{}")
      })
      const events = yield* makeCollectingFlowEvents
      const ado = makeAzureDevOpsTool(config, recording.client, events)
      const item = yield* ado.readWorkItem(7)
      const pr = yield* ado.createPr("refs/heads/feature", "refs/heads/main", "Title", "Body")
      const readOnly = new Grants({
        ...allGrants,
        ado: "Read"
      })
      const denied = yield* Effect.flip(restricted(readOnly)(ado.setState(7, "Active")))
      const requests = yield* recording.recorded

      assert.strictEqual(item.id, 7)
      assert.strictEqual(pr.id, 9)
      assert.match(pr.webUrl, /pullrequest\/9/)
      assert.strictEqual(denied._tag, "CapabilityDenied")
      assert.strictEqual(requests.length, 2)
      assert.notMatch(requests.map((request) => request.url).join(" "), /token/)
      assert.isTrue(requests.every((request) => request.headers.Authorization === "Basic OnRva2Vu"))
    })
  )
})
