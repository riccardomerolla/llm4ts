import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Capabilities } from "@llm4ts/core/Capability"
import type { HttpClientShape } from "@llm4ts/core/HttpClient"
import type { JsonValue } from "@llm4ts/core/providers/CliSupport"
import { ProcessError, type FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { guarded } from "./CapabilityGuard.ts"

export class AdoRequest extends Schema.Class<AdoRequest>("AdoRequest")({
  method: Schema.String,
  url: Schema.String,
  body: Schema.optionalKey(Schema.String),
  contentType: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("application/json")))
}) {}

export class WorkItem extends Schema.Class<WorkItem>("WorkItem")({
  id: Schema.Int,
  title: Schema.String,
  description: Schema.String,
  acceptanceCriteria: Schema.String,
  state: Schema.String,
  tags: Schema.Array(Schema.String)
}) {}

export class AdoPullRequest extends Schema.Class<AdoPullRequest>("AdoPullRequest")({
  id: Schema.Int,
  repoId: Schema.String,
  projectId: Schema.String,
  webUrl: Schema.String
}) {}

export class AdoConfig extends Schema.Class<AdoConfig>("AdoConfig")({
  orgUrl: Schema.String,
  project: Schema.String,
  repository: Schema.String,
  pat: Schema.Redacted(Schema.String, {
    disallowJsonEncode: true
  }),
  apiVersion: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("7.1")))
}) {}

const encodeBase64 = (value: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const bytes = new TextEncoder().encode(value)
  let encoded = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const bits = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    encoded += alphabet[(bits >>> 18) & 63] ?? ""
    encoded += alphabet[(bits >>> 12) & 63] ?? ""
    encoded += second === undefined ? "=" : (alphabet[(bits >>> 6) & 63] ?? "")
    encoded += third === undefined ? "=" : (alphabet[bits & 63] ?? "")
  }
  return encoded
}

export const authorizationHeader = (config: AdoConfig): Readonly<Record<string, string>> => ({
  Authorization: `Basic ${encodeBase64(`:${Redacted.value(config.pat)}`)}`
})

const witBase = (config: AdoConfig): string => `${config.orgUrl}/${config.project}/_apis/wit`
const gitBase = (config: AdoConfig): string =>
  `${config.orgUrl}/${config.project}/_apis/git/repositories/${config.repository}`

const patchOperations = (fields: Readonly<Record<string, string>>): ReadonlyArray<JsonValue> =>
  Object.entries(fields).map(([name, value]) => ({
    op: "add",
    path: `/fields/${name}`,
    value
  }))

export const readWorkItemRequest = (config: AdoConfig, id: number): AdoRequest =>
  AdoRequest.make({
    method: "GET",
    url: `${witBase(config)}/workitems/${id}?$expand=relations&api-version=${config.apiVersion}`
  })

export const wiqlRequest = (config: AdoConfig, query: string): AdoRequest =>
  AdoRequest.make({
    method: "POST",
    url: `${witBase(config)}/wiql?api-version=${config.apiVersion}`,
    body: JSON.stringify({ query })
  })

export const setFieldsRequest = (
  config: AdoConfig,
  id: number,
  fields: Readonly<Record<string, string>>
): AdoRequest =>
  AdoRequest.make({
    method: "PATCH",
    url: `${witBase(config)}/workitems/${id}?api-version=${config.apiVersion}`,
    body: JSON.stringify(patchOperations(fields)),
    contentType: "application/json-patch+json"
  })

export const createPullRequestRequest = (
  config: AdoConfig,
  sourceRef: string,
  targetRef: string,
  title: string,
  description: string
): AdoRequest =>
  AdoRequest.make({
    method: "POST",
    url: `${gitBase(config)}/pullrequests?api-version=${config.apiVersion}`,
    body: JSON.stringify({
      sourceRefName: sourceRef,
      targetRefName: targetRef,
      title,
      description
    })
  })

const field = (fields: Readonly<Record<string, JsonValue>>, name: string): string => {
  const value = fields[name]
  return typeof value === "string" ? value : ""
}

export const parseWorkItem = (json: string): Effect.Effect<WorkItem, ProcessError> =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        id: Schema.Int,
        fields: Schema.Record(Schema.String, Schema.Json)
      })
    )
  )(json).pipe(
    Effect.map((item) => {
      const tags = field(item.fields, "System.Tags")
        .split(";")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
      return WorkItem.make({
        id: item.id,
        title: field(item.fields, "System.Title"),
        description: field(item.fields, "System.Description"),
        acceptanceCriteria: field(item.fields, "Microsoft.VSTS.Common.AcceptanceCriteria"),
        state: field(item.fields, "System.State"),
        tags
      })
    }),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "ado parse work item",
        detail: String(error)
      })
    )
  )

export const parseWiqlIds = (json: string): Effect.Effect<ReadonlyArray<number>, ProcessError> =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        workItems: Schema.Array(
          Schema.Struct({
            id: Schema.Int
          })
        )
      })
    )
  )(json).pipe(
    Effect.map((result) => result.workItems.map((item) => item.id)),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "ado parse wiql",
        detail: String(error)
      })
    )
  )

export const parsePullRequest = (
  config: AdoConfig,
  json: string
): Effect.Effect<AdoPullRequest, ProcessError> =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        pullRequestId: Schema.Int,
        repository: Schema.Struct({
          id: Schema.String,
          project: Schema.Struct({
            id: Schema.String
          })
        })
      })
    )
  )(json).pipe(
    Effect.map((result) =>
      AdoPullRequest.make({
        id: result.pullRequestId,
        repoId: result.repository.id,
        projectId: result.repository.project.id,
        webUrl:
          `${config.orgUrl}/${config.project}/_git/` +
          `${config.repository}/pullrequest/${result.pullRequestId}`
      })
    ),
    Effect.mapError((error) =>
      ProcessError.make({
        message: "ado parse pull request",
        detail: String(error)
      })
    )
  )

export interface AzureDevOpsToolShape {
  readonly readWorkItem: (id: number) => Effect.Effect<WorkItem, FlowError>
  readonly wiqlIds: (query: string) => Effect.Effect<ReadonlyArray<number>, FlowError>
  readonly setFields: (
    id: number,
    fields: Readonly<Record<string, string>>
  ) => Effect.Effect<void, FlowError>
  readonly setState: (id: number, state: string) => Effect.Effect<void, FlowError>
  readonly setAcceptanceCriteria: (id: number, text: string) => Effect.Effect<void, FlowError>
  readonly createPr: (
    sourceRef: string,
    targetRef: string,
    title: string,
    body: string
  ) => Effect.Effect<AdoPullRequest, FlowError>
}

export const makeAzureDevOpsTool = (
  config: AdoConfig,
  http: HttpClientShape,
  events: FlowEventsShape,
  timeout: Duration.Duration = Duration.seconds(30)
): AzureDevOpsToolShape => {
  const run = (request: AdoRequest): Effect.Effect<string, FlowError> =>
    http
      .send(
        request.method,
        request.url,
        request.body,
        authorizationHeader(config),
        request.contentType,
        timeout
      )
      .pipe(
        Effect.mapError((error) =>
          ProcessError.make({
            message: `ado ${request.method} ${request.url}`,
            detail: error.message
          })
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

  const setFields = (
    id: number,
    fields: Readonly<Record<string, string>>
  ): Effect.Effect<void, FlowError> =>
    write("ado setFields", run(setFieldsRequest(config, id, fields)).pipe(Effect.asVoid))

  return {
    readWorkItem: (id) =>
      read(
        "ado readWorkItem",
        run(readWorkItemRequest(config, id)).pipe(Effect.flatMap(parseWorkItem))
      ),
    wiqlIds: (query) =>
      read("ado wiql", run(wiqlRequest(config, query)).pipe(Effect.flatMap(parseWiqlIds))),
    setFields,
    setState: (id, state) => setFields(id, { "System.State": state }),
    setAcceptanceCriteria: (id, text) =>
      setFields(id, {
        "Microsoft.VSTS.Common.AcceptanceCriteria": text
      }),
    createPr: (sourceRef, targetRef, title, body) =>
      write(
        "ado createPr",
        run(createPullRequestRequest(config, sourceRef, targetRef, title, body)).pipe(
          Effect.flatMap((json) => parsePullRequest(config, json))
        )
      )
  }
}
