import * as Effect from "effect/Effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import type { HttpClientRequest } from "effect/unstable/http"

/**
 * The client-only stand-in for a service API. Each domain declares its
 * contract as an Effect `HttpApi` and, next to it, the fake routes that
 * answer that contract from deterministic fixture data. The routes are
 * plain functions over an in-memory store that lives as long as the page,
 * so a transfer created, then confirmed, then listed behaves like a real
 * service would. Swapping for a real backend is one config line
 * (`VITE_TRANSPORT=http`): the contract is the same.
 */
export interface FakeRequest {
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** Decoded JSON body, or undefined without one. */
  readonly body: unknown
}

export interface FakeReply {
  readonly status?: number
  readonly body?: unknown
}

export interface FakeRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE"
  /** Path with `:name` parameters, as the contract declares it. */
  readonly path: string
  readonly handle: (request: FakeRequest) => FakeReply
}

export type FakeRoutes = ReadonlyArray<FakeRoute>

/** A refusal in the shape the contract's `HttpApiError` schemas decode. */
export const refuse = (status: number, tag: string): FakeReply => ({ status, body: { _tag: tag } })
export const notFound = (): FakeReply => refuse(404, "NotFound")
export const unprocessable = (): FakeReply => refuse(422, "UnprocessableEntity")
export const conflict = (): FakeReply => refuse(409, "Conflict")

const matchPath = (pattern: string, pathname: string): Readonly<Record<string, string>> | undefined => {
  const expected = pattern.split("/").filter((part) => part.length > 0)
  const actual = pathname.split("/").filter((part) => part.length > 0)
  if (expected.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] ?? ""
    const got = actual[index] ?? ""
    if (want.startsWith(":")) {
      params[want.slice(1)] = decodeURIComponent(got)
    } else if (want !== got) {
      return undefined
    }
  }
  return params
}

const decoder = new TextDecoder()

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body
  if (body._tag === "Uint8Array") {
    const text = decoder.decode(body.body)
    return text.length === 0 ? undefined : JSON.parse(text)
  }
  return undefined
}

/** An `HttpClient` that never touches the network: it answers from `routes`. */
export const fakeHttpClient = (routes: FakeRoutes): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    Effect.sync(() => {
      const route = routes.find((candidate) => {
        if (candidate.method !== request.method) return false
        return matchPath(candidate.path, url.pathname) !== undefined
      })
      const params = route === undefined ? undefined : matchPath(route.path, url.pathname)
      const reply =
        route === undefined || params === undefined
          ? notFound()
          : route.handle({ params, query: url.searchParams, body: bodyOf(request) })
      const status = reply.status ?? 200
      const init: ResponseInit = {
        status,
        headers: reply.body === undefined ? {} : { "content-type": "application/json" }
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.body === undefined ? null : JSON.stringify(reply.body), init)
      )
    })
  )
