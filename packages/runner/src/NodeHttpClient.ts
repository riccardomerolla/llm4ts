import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { HttpClient, makeHttpClient, type HttpClientShape } from "@llm4ts/core/HttpClient"
import {
  AuthenticationError,
  InvalidRequestError,
  ParseError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  type LlmError
} from "@llm4ts/core/Errors"

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const checkedUrl = (raw: string): Effect.Effect<string, InvalidRequestError> =>
  Effect.try({
    try: () => new URL(raw).toString(),
    catch: (error) =>
      InvalidRequestError.make({
        message: `Invalid URL '${raw}': ${errorMessage(error)}`
      })
  })

const fetchResponse = (
  rawUrl: string,
  init: RequestInit,
  timeout: Duration.Duration
): Effect.Effect<Response, LlmError> =>
  Effect.flatMap(checkedUrl(rawUrl), (url) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          ...init,
          signal
        }),
      catch: (error) =>
        ProviderError.make({
          message: `Provider unavailable: ${rawUrl}`,
          cause: error
        })
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            TimeoutError.make({
              duration: timeout
            })
          )
      })
    )
  )

const responseText = (response: Response): Effect.Effect<string, ParseError> =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (error) =>
      ParseError.make({
        message: errorMessage(error),
        raw: ""
      })
  })

const retryAfter = (response: Response, fallback: Duration.Duration): Duration.Duration => {
  const value = response.headers.get("Retry-After")?.trim()
  return value !== undefined && /^\d+$/.test(value) ? Duration.seconds(Number(value)) : fallback
}

const classifyBodyResponse = (
  response: Response,
  url: string,
  timeout: Duration.Duration,
  accepts: (status: number) => boolean
): Effect.Effect<string, LlmError> =>
  Effect.flatMap(responseText(response), (body): Effect.Effect<string, LlmError> => {
    const status = response.status
    if (accepts(status)) {
      return Effect.succeed(body)
    }
    if (status === 401 || status === 403) {
      return Effect.fail(AuthenticationError.make({ message: url }))
    }
    if (status === 429) {
      return Effect.fail(
        RateLimitError.make({
          retryAfter: retryAfter(response, timeout)
        })
      )
    }
    if (status >= 400 && status < 500) {
      return Effect.fail(
        InvalidRequestError.make({
          message: `HTTP ${status}: ${body}`
        })
      )
    }
    return Effect.fail(
      ProviderError.make({
        message: `HTTP ${status}: ${body}`
      })
    )
  })

const requestHeaders = (
  headers: Readonly<Record<string, string>>,
  contentType: string | undefined
): Headers => {
  const result = new Headers(headers)
  if (contentType !== undefined && !result.has("Content-Type")) {
    result.set("Content-Type", contentType)
  }
  return result
}

const requestBody = (
  method: string,
  url: string,
  body: string | undefined,
  headers: Readonly<Record<string, string>>,
  contentType: string | undefined,
  timeout: Duration.Duration,
  accepts: (status: number) => boolean
): Effect.Effect<string, LlmError> =>
  Effect.flatMap(
    fetchResponse(
      url,
      {
        method,
        headers: requestHeaders(headers, contentType),
        ...(body === undefined ? {} : { body })
      },
      timeout
    ),
    (response) => classifyBodyResponse(response, url, timeout, accepts)
  )

const streamBody = (
  response: Response,
  url: string,
  timeout: Duration.Duration
): Stream.Stream<string, LlmError> => {
  if (response.status !== 200) {
    return Stream.fromEffect(
      classifyBodyResponse(response, url, timeout, (status) => status === 200)
    )
  }
  const body = response.body
  if (body === null) {
    return Stream.fail(
      ProviderError.make({
        message: `Provider returned no streaming body: ${url}`
      })
    )
  }

  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: (error) =>
      ProviderError.make({
        message: `Failed to read streaming response from ${url}`,
        cause: error
      })
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Stream.fail(
          TimeoutError.make({
            duration: timeout
          })
        )
    })
  )
}

const postJsonStream: HttpClientShape["postJsonStream"] = (url, body, headers, timeout) =>
  Stream.unwrap(
    Effect.map(
      fetchResponse(
        url,
        {
          method: "POST",
          headers: requestHeaders(headers, "application/json"),
          body
        },
        timeout
      ),
      (response) => streamBody(response, url, timeout)
    )
  )

export const nodeHttpClient: HttpClientShape = makeHttpClient({
  get: (url, headers, timeout) =>
    requestBody("GET", url, undefined, headers, undefined, timeout, (status) => status === 200),
  postJson: (url, body, headers, timeout) =>
    requestBody(
      "POST",
      url,
      body,
      headers,
      "application/json",
      timeout,
      (status) => status === 200
    ),
  send: (method, url, body, headers, contentType, timeout) =>
    requestBody(
      method,
      url,
      body,
      headers,
      contentType,
      timeout,
      (status) => status >= 200 && status < 300
    ),
  postJsonStream
})

export const NodeHttpClientLive = Layer.succeed(HttpClient)(nodeHttpClient)
