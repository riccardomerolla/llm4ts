import * as Effect from "effect/Effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { HttpApiClient, HttpApiGroup } from "effect/unstable/httpapi"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useAuth } from "./auth.tsx"
import { useConfig } from "./config.tsx"
import { fakeHttpClient, type FakeRoutes } from "./fake-transport.ts"
import { useMessages, type Translate } from "./i18n.tsx"
import { kitMessages, type KitMessageKey } from "./messages.ts"

/**
 * A domain as a feature sees it: the fake routes that answer its contract
 * and how to connect a typed client to a transport. Each domain module
 * exports one (`<domain>Domain`); features import the domain they need.
 * Nothing registers domains centrally. `C` is the domain's typed client —
 * fixed where `domain(...)` is called with a concrete `HttpApi`, which is
 * also where the client's (absent) middleware requirement resolves.
 */
export interface Domain<C> {
  readonly fake: FakeRoutes
  readonly connect: (httpClient: HttpClient.HttpClient, baseUrl: string) => Effect.Effect<C>
}

export const domain = <C>(
  fake: FakeRoutes,
  connect: (httpClient: HttpClient.HttpClient, baseUrl: string) => Effect.Effect<C>
): Domain<C> => ({ fake, connect })

/** The typed client for an `HttpApi` over the plain `HttpClient`. */
export type Client<Groups extends HttpApiGroup.Constraint> = HttpApiClient.Client<Groups, never, never>

/**
 * The client for a domain. Building one is cheap and stateless: the fake
 * transport's state lives in the domain's route module for the page's life,
 * and the HTTP transport attaches the bearer token to every request.
 */
export const clientFor = <C>(
  target: Domain<C>,
  transport: "fake" | "http",
  baseUrl: string,
  token: string
): Effect.Effect<C> => {
  const httpClient: Effect.Effect<HttpClient.HttpClient> =
    transport === "fake"
      ? Effect.succeed(fakeHttpClient(target.fake))
      : Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient
          return HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token))
        }).pipe(Effect.provide(FetchHttpClient.layer))
  return Effect.flatMap(httpClient, (client) =>
    target.connect(client, transport === "fake" ? "http://fake.local" : baseUrl)
  )
}

/** The browser is a runtime boundary: effects become promises here and nowhere else. */
export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

export interface Loaded<A> {
  readonly data: A | undefined
  readonly error: string | undefined
  readonly loading: boolean
  readonly reload: () => void
}

const raw = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message === "" ? cause.name : cause.message
  if (typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string") {
    return cause._tag
  }
  return String(cause)
}

const statusOf = (cause: unknown): number | undefined => {
  if (typeof cause === "object" && cause !== null) {
    if ("status" in cause && typeof cause.status === "number") return cause.status
    const response: unknown = "response" in cause ? cause.response : undefined
    if (
      typeof response === "object" &&
      response !== null &&
      "status" in response &&
      typeof response.status === "number"
    ) {
      return response.status
    }
  }
  const found = /\((\d{3})\s/.exec(raw(cause))
  return found === null ? undefined : Number(found[1])
}

const EXPLANATION: ReadonlyMap<number, KitMessageKey> = new Map([
  [400, "error.400"],
  [401, "error.401"],
  [403, "error.403"],
  [404, "error.404"],
  [409, "error.409"],
  [422, "error.422"],
  [500, "error.500"],
  [503, "error.503"]
])

/** What a refusal means to the customer reading it, not a bare status code. */
export const describeFailure = (t: Translate<KitMessageKey>, cause: unknown): string => {
  const status = statusOf(cause)
  if (status === undefined) return raw(cause)
  const key = EXPLANATION.get(status)
  return key === undefined ? t("error.status", { status: String(status) }) : `${t(key)} (${status})`
}

/** Loads data through a domain's client, re-running when `deps` change or `reload` is called. */
export const useLoad = <C, A>(
  target: Domain<C>,
  load: (client: C) => Effect.Effect<A, unknown>,
  deps: ReadonlyArray<unknown>
): Loaded<A> => {
  const { customer } = useAuth()
  const config = useConfig()
  const t = useMessages(kitMessages)
  const [data, setData] = useState<A | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  const depsKey = JSON.stringify(deps)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    run(
      clientFor(target, config.transport, config.apiUrl, customer.token).pipe(Effect.flatMap(load))
    )
      .then((value) => {
        if (cancelled) return
        setData(value)
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describeFailure(t, cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `load` is an inline lambda; its inputs are what `deps` names.
  }, [target, config.transport, config.apiUrl, customer.token, tick, depsKey])
  return useMemo(() => ({ data, error, loading, reload }), [data, error, loading, reload])
}

/** Runs one call through a domain's client and reports its outcome, for buttons and forms. */
export const useAction = <C>(target: Domain<C>) => {
  const { customer } = useAuth()
  const config = useConfig()
  const t = useMessages(kitMessages)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [tone, setTone] = useState<"info" | "error">("info")
  const act = useCallback(
    async <A>(label: string, call: (client: C) => Effect.Effect<A, unknown>): Promise<A | undefined> => {
      setBusy(true)
      setMessage(undefined)
      try {
        const result = await run(
          clientFor(target, config.transport, config.apiUrl, customer.token).pipe(Effect.flatMap(call))
        )
        setTone("info")
        setMessage(t("action.done", { label }))
        return result
      } catch (cause: unknown) {
        setTone("error")
        setMessage(t("action.refused", { label, reason: describeFailure(t, cause) }))
        return undefined
      } finally {
        setBusy(false)
      }
    },
    [target, config.transport, config.apiUrl, customer.token, t]
  )
  return { act, busy, message, tone } as const
}

export interface Page<A> {
  readonly items: ReadonlyArray<A>
  readonly nextCursor?: string
}

export interface Paged<A> extends Loaded<ReadonlyArray<A>> {
  readonly hasMore: boolean
  readonly loadMore: () => void
}

/**
 * A paged list the reader extends one page at a time. The pages opened so
 * far are re-read together on every refresh; a change of `deps` starts
 * again from the first page.
 */
export const usePages = <C, A>(
  target: Domain<C>,
  load: (client: C, cursor: string | undefined) => Effect.Effect<Page<A>, unknown>,
  deps: ReadonlyArray<unknown>
): Paged<A> => {
  const [pages, setPages] = useState(1)
  const loaded = useLoad(
    target,
    (client) =>
      Effect.gen(function* () {
        const items: Array<A> = []
        let cursor: string | undefined = undefined
        let hasMore = false
        for (let n = 0; n < pages; n += 1) {
          const page: Page<A> = yield* load(client, cursor)
          items.push(...page.items)
          hasMore = page.nextCursor !== undefined
          if (!hasMore) break
          cursor = page.nextCursor
        }
        return { items, hasMore }
      }),
    [pages, ...deps]
  )
  const depsKey = JSON.stringify(deps)
  useEffect(() => setPages(1), [depsKey])
  const loadMore = useCallback(() => setPages((n) => n + 1), [])
  return useMemo(
    () => ({
      data: loaded.data?.items,
      error: loaded.error,
      loading: loaded.loading,
      reload: loaded.reload,
      hasMore: loaded.data?.hasMore ?? false,
      loadMore
    }),
    [loaded, loadMore]
  )
}
