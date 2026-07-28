import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, type LlmError } from "./Errors.ts"

const emptyHeaders: Readonly<Record<string, string>> = Object.freeze({})

export class HttpRequest extends Schema.Class<HttpRequest>("HttpRequest")({
  method: Schema.String,
  url: Schema.String,
  body: Schema.optionalKey(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyHeaders))
  ),
  contentType: Schema.String.pipe(
    Schema.withConstructorDefault(Effect.succeed("application/json"))
  ),
  timeout: Schema.Duration
}) {}

export interface HttpClientShape {
  readonly get: (
    url: string,
    headers: Readonly<Record<string, string>>,
    timeout: Duration.Duration
  ) => Effect.Effect<string, LlmError>
  readonly postJson: (
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    timeout: Duration.Duration
  ) => Effect.Effect<string, LlmError>
  readonly send: (
    method: string,
    url: string,
    body: string | undefined,
    headers: Readonly<Record<string, string>>,
    contentType: string,
    timeout: Duration.Duration
  ) => Effect.Effect<string, LlmError>
  readonly postJsonStream: (
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    timeout: Duration.Duration
  ) => Stream.Stream<string, LlmError>
  readonly postJsonStreamSSE: (
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    timeout: Duration.Duration
  ) => Stream.Stream<string, LlmError>
}

export class HttpClient extends Context.Service<HttpClient, HttpClientShape>()(
  "@llm4ts/core/HttpClient"
) {}

export interface HttpClientPrimitives {
  readonly postJson: HttpClientShape["postJson"]
  readonly get?: HttpClientShape["get"]
  readonly send?: HttpClientShape["send"]
  readonly postJsonStream?: HttpClientShape["postJsonStream"]
  readonly postJsonStreamSSE?: HttpClientShape["postJsonStreamSSE"]
}

export const makeHttpClient = (primitives: HttpClientPrimitives): HttpClientShape => {
  const get: HttpClientShape["get"] =
    primitives.get ??
    ((_url, _headers, _timeout) =>
      Effect.fail(
        InvalidRequestError.make({
          message: "GET is not supported by this HttpClient implementation"
        })
      ))

  const send: HttpClientShape["send"] =
    primitives.send ??
    ((_method, _url, _body, _headers, _contentType, _timeout) =>
      Effect.fail(
        InvalidRequestError.make({
          message: "send is not supported by this HttpClient implementation"
        })
      ))

  const postJsonStream: HttpClientShape["postJsonStream"] =
    primitives.postJsonStream ??
    ((url, body, headers, timeout) =>
      Stream.flatMap(Stream.fromEffect(primitives.postJson(url, body, headers, timeout)), (raw) =>
        Stream.fromIterable(raw.split(/\r?\n/))
      ))

  const postJsonStreamSSE: HttpClientShape["postJsonStreamSSE"] =
    primitives.postJsonStreamSSE ??
    ((url, body, headers, timeout) =>
      postJsonStream(url, body, headers, timeout).pipe(
        Stream.filter((line) => line.startsWith("data: ")),
        Stream.map((line) => line.slice("data: ".length).trim()),
        Stream.filter((payload) => payload.length > 0 && payload !== "[DONE]")
      ))

  return {
    get,
    postJson: primitives.postJson,
    send,
    postJsonStream,
    postJsonStreamSSE
  }
}

export interface RecordingHttpClient {
  readonly client: HttpClientShape
  readonly recorded: Effect.Effect<ReadonlyArray<HttpRequest>>
}

export const makeRecordingHttpClient = Effect.fn("@llm4ts/core/HttpClient.makeRecording")(
  function* (
    handler: (request: HttpRequest) => Effect.Effect<string, LlmError>,
    streamHandler?: (request: HttpRequest) => Stream.Stream<string, LlmError>
  ): Effect.fn.Return<RecordingHttpClient> {
    const requests = yield* Ref.make<ReadonlyArray<HttpRequest>>([])
    const record = (request: HttpRequest): Effect.Effect<void> =>
      Ref.update(requests, (current) => [...current, request])

    const postJson: HttpClientShape["postJson"] = (url, body, headers, timeout) => {
      const request = HttpRequest.make({
        method: "POST",
        url,
        body,
        headers,
        contentType: "application/json",
        timeout
      })
      return record(request).pipe(Effect.andThen(handler(request)))
    }

    const client = makeHttpClient({
      postJson,
      get: (url, headers, timeout) => {
        const request = HttpRequest.make({
          method: "GET",
          url,
          headers,
          timeout
        })
        return record(request).pipe(Effect.andThen(handler(request)))
      },
      send: (method, url, body, headers, contentType, timeout) => {
        const request = HttpRequest.make({
          method,
          url,
          ...(body === undefined ? {} : { body }),
          headers,
          contentType,
          timeout
        })
        return record(request).pipe(Effect.andThen(handler(request)))
      },
      ...(streamHandler === undefined
        ? {}
        : {
            postJsonStream: (url, body, headers, timeout) => {
              const request = HttpRequest.make({
                method: "POST",
                url,
                body,
                headers,
                contentType: "application/json",
                timeout
              })
              return Stream.concat(
                Stream.drain(Stream.fromEffect(record(request))),
                Stream.suspend(() => streamHandler(request))
              )
            }
          })
    })

    return {
      client,
      recorded: Ref.get(requests)
    }
  }
)

export const httpGet = (
  url: string,
  headers: Readonly<Record<string, string>> = emptyHeaders,
  timeout: Duration.Duration
): Effect.Effect<string, LlmError, HttpClient> =>
  Effect.flatMap(HttpClient, (client) => client.get(url, headers, timeout))

export const httpPostJson = (
  url: string,
  body: string,
  headers: Readonly<Record<string, string>> = emptyHeaders,
  timeout: Duration.Duration
): Effect.Effect<string, LlmError, HttpClient> =>
  Effect.flatMap(HttpClient, (client) => client.postJson(url, body, headers, timeout))
