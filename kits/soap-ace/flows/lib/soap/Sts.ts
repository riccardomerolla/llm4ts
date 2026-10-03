import { randomBytes } from "node:crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import {
  type AuthProfileError,
  defaultStsTemplate,
  defaultTokenElement,
  resolvePrincipal,
  resolveProxy,
  resolveText,
  resolveTls,
  type SecretSource,
  type StsConfig
} from "./Auth.ts"
import type { SoapVersion } from "./Catalog.ts"
import {
  envelopeNamespace,
  readEnvelope,
  soapHeaders,
  WsseNamespace,
  WsuNamespace
} from "./Envelope.ts"
import { serviceDirectory } from "./Discover.ts"
import { displayUrl, type SoapTransportShape, type TransportError } from "./Transport.ts"
import { decodeXml, parseXml, type XmlElement, type XmlError } from "./Xml.ts"

// A SAML bearer token from an STS (WS-Trust): the request is a template the
// user owns under the service folder, filled with the credential, a nonce
// and timestamps, posted with the STS side's auth, TLS and proxy; the first
// element named `token.element` in the answer is carried as the raw bytes
// of the response, so a signature over it survives. The token lives in
// memory for the run only and is renewed before it expires.

export class StsError extends Schema.TaggedError<StsError>()("StsError", {
  endpoint: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `STS ${this.endpoint}: ${this.detail}`
  }
}

export const stsTemplatePath = (service: string, config: StsConfig): string =>
  `${serviceDirectory(service)}/${config.template ?? defaultStsTemplate}`

const WsTrust = "http://docs.oasis-open.org/ws-sx/ws-trust/200512"
const WsPolicy = "http://schemas.xmlsoap.org/ws/2004/09/policy"
const WsAddressing = "http://www.w3.org/2005/08/addressing"
const TokenProfile =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0"

/** The WS-Trust 1.3 Issue request `sts init` writes; every placeholder is filled per call. */
export const renderDefaultStsTemplate = (soapVersion: SoapVersion = "1.1"): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- The STS request soap-sample fills before every token call. Placeholders:",
    "     {{username}} {{password}} {{created}} {{expires}} {{nonce}} {{appliesTo}}.",
    "     Edit freely: this file is yours; soap-sample only fills the placeholders. -->",
    `<soapenv:Envelope xmlns:soapenv="${envelopeNamespace(soapVersion)}"`,
    `    xmlns:wsse="${WsseNamespace}"`,
    `    xmlns:wsu="${WsuNamespace}"`,
    `    xmlns:wst="${WsTrust}"`,
    `    xmlns:wsp="${WsPolicy}"`,
    `    xmlns:wsa="${WsAddressing}">`,
    "  <soapenv:Header>",
    `    <wsa:Action>${WsTrust}/RST/Issue</wsa:Action>`,
    '    <wsse:Security soapenv:mustUnderstand="1">',
    '      <wsu:Timestamp wsu:Id="TS-1">',
    "        <wsu:Created>{{created}}</wsu:Created>",
    "        <wsu:Expires>{{expires}}</wsu:Expires>",
    "      </wsu:Timestamp>",
    '      <wsse:UsernameToken wsu:Id="UsernameToken-1">',
    "        <wsse:Username>{{username}}</wsse:Username>",
    `        <wsse:Password Type="${TokenProfile}#PasswordText">{{password}}</wsse:Password>`,
    "        <wsse:Nonce>{{nonce}}</wsse:Nonce>",
    "        <wsu:Created>{{created}}</wsu:Created>",
    "      </wsse:UsernameToken>",
    "    </wsse:Security>",
    "  </soapenv:Header>",
    "  <soapenv:Body>",
    "    <wst:RequestSecurityToken>",
    `      <wst:RequestType>${WsTrust}/Issue</wst:RequestType>`,
    "      <wst:TokenType>http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLV2.0</wst:TokenType>",
    `      <wst:KeyType>${WsTrust}/Bearer</wst:KeyType>`,
    "      <wsp:AppliesTo>",
    "        <wsa:EndpointReference>",
    "          <wsa:Address>{{appliesTo}}</wsa:Address>",
    "        </wsa:EndpointReference>",
    "      </wsp:AppliesTo>",
    "    </wst:RequestSecurityToken>",
    "  </soapenv:Body>",
    "</soapenv:Envelope>",
    ""
  ].join("\n")

export interface TemplateValues {
  readonly username: string
  readonly password: Redacted.Redacted<string>
  readonly created: string
  readonly expires: string
  readonly nonce: string
  readonly appliesTo: string
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Fills `{{name}}` placeholders; values are escaped for XML text. Unknown placeholders stay. */
export const fillStsTemplate = (
  template: string,
  values: TemplateValues
): Redacted.Redacted<string> => {
  const table: Record<string, string> = {
    username: escapeXml(values.username),
    password: escapeXml(Redacted.value(values.password)),
    created: values.created,
    expires: values.expires,
    nonce: values.nonce,
    appliesTo: escapeXml(values.appliesTo)
  }
  return Redacted.make(
    template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name: string) => table[name] ?? whole)
  )
}

/** The names the template fills, for `check` to compare with what it holds. */
export const templatePlaceholders = (template: string): ReadonlyArray<string> =>
  [...new Set([...template.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)].map((m) => m[1] ?? ""))].sort()

const findElement = (root: XmlElement, local: string): XmlElement | undefined => {
  if (root.name.local === local) {
    return root
  }
  for (const child of root.children) {
    if (child._tag === "element") {
      const found = findElement(child, local)
      if (found !== undefined) {
        return found
      }
    }
  }
  return undefined
}

/**
 * The first element named `local` in `text`, exactly as written (its span),
 * or `undefined`. The text must be the parsed document: spans index it.
 */
export const extractElementRaw = (
  text: string,
  root: XmlElement,
  local: string
): string | undefined => {
  const found = findElement(root, local)
  return found?.span === undefined ? undefined : text.slice(found.span.start, found.span.end)
}

const attributeOf = (element: XmlElement, local: string): string | undefined =>
  element.attributes.find((attribute) => attribute.name.local === local)?.value

/** `Conditions/@NotOnOrAfter` of a SAML assertion, when it carries one. */
export const notOnOrAfterOf = (root: XmlElement, tokenLocal: string): Date | undefined => {
  const assertion = findElement(root, tokenLocal)
  if (assertion === undefined) {
    return undefined
  }
  const conditions = findElement(assertion, "Conditions")
  const value = conditions === undefined ? undefined : attributeOf(conditions, "NotOnOrAfter")
  if (value === undefined) {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export interface SamlToken {
  /** The token element, bytes as received. */
  readonly token: Redacted.Redacted<string>
  readonly notOnOrAfter: Date | undefined
  /** Which element was carried and how long it is, for the terminal. */
  readonly element: string
  readonly chars: number
}

export interface FetchTokenOptions {
  readonly workspace: WorkspaceShape
  readonly service: string
  readonly config: StsConfig
  readonly secrets: SecretSource
  readonly transport: SoapTransportShape
  readonly now?: () => Date
  readonly random?: (size: number) => Uint8Array
}

export type StsFailure = StsError | AuthProfileError | TransportError | WorkspaceError | XmlError

/** One STS call: fill the template, post it, carry the token element verbatim. */
export const fetchSamlToken = (options: FetchTokenOptions): Effect.Effect<SamlToken, StsFailure> =>
  Effect.gen(function* () {
    const { config } = options
    const shown = displayUrl(config.endpoint)
    const path = stsTemplatePath(options.service, config)
    const found = yield* options.workspace.discover(path)
    if (!found.includes(path)) {
      return yield* new StsError({
        endpoint: shown,
        detail: `no request template at ${path}; write it with soap-sample "sts init"`
      })
    }
    const template = yield* options.workspace.read(path)
    const now = options.now ?? (() => new Date())
    const random = options.random ?? ((size: number) => new Uint8Array(randomBytes(size)))
    const created = now()
    const envelope = fillStsTemplate(template, {
      username: yield* resolvePrincipal(options.secrets, config.auth.user),
      password: yield* resolveText(options.secrets, config.auth.password),
      created: created.toISOString(),
      expires: new Date(created.getTime() + 5 * 60_000).toISOString(),
      nonce: Buffer.from(random(16)).toString("base64"),
      appliesTo: config.appliesTo ?? ""
    })
    const tls = yield* resolveTls(options.secrets, config.tls)
    const proxy = yield* resolveProxy(options.secrets, config.proxy)
    const version = config.soapVersion ?? "1.1"
    const response = yield* options.transport.send({
      method: "POST",
      url: config.endpoint,
      headers: soapHeaders(version, `${WsTrust}/RST/Issue`),
      secretHeaders: [],
      body: envelope,
      ...(tls === undefined ? {} : { tls }),
      ...(proxy === undefined ? {} : { proxy }),
      timeout: Duration.seconds(config.timeoutSeconds ?? 60)
    })
    const text = yield* decodeXml(response.body, "sts response")
    const root = yield* parseXml(text, { source: "sts response" }).pipe(
      Effect.mapError(
        () =>
          new StsError({
            endpoint: shown,
            detail: `HTTP ${response.status} with a body that is not XML`
          })
      )
    )
    const read = yield* readEnvelope(root).pipe(Effect.option)
    if (read._tag === "Some" && read.value.fault !== undefined) {
      return yield* new StsError({
        endpoint: shown,
        detail: `fault ${read.value.fault.code}: ${read.value.fault.reason}`
      })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new StsError({ endpoint: shown, detail: `HTTP ${response.status}` })
    }
    const element = config.token?.element ?? defaultTokenElement
    const raw = extractElementRaw(text, root, element)
    if (raw === undefined) {
      return yield* new StsError({
        endpoint: shown,
        detail: `no ${element} element in the response (set sts.token.element to the one it carries)`
      })
    }
    return {
      token: Redacted.make(raw),
      notOnOrAfter: notOnOrAfterOf(root, element),
      element,
      chars: raw.length
    }
  })

export interface TokenSource {
  /** The current token, fetched or renewed as needed. */
  readonly current: Effect.Effect<SamlToken, StsFailure>
  /** How many STS calls were made, for the terminal and tests. */
  readonly fetches: Effect.Effect<number>
}

/**
 * The run's token: fetched on first use, renewed `renewBeforeSeconds`
 * before `NotOnOrAfter` (a token without one lasts the run). Never persisted.
 */
export const makeTokenSource = (options: FetchTokenOptions): Effect.Effect<TokenSource> =>
  Effect.gen(function* () {
    const cache = yield* Ref.make<SamlToken | undefined>(undefined)
    const count = yield* Ref.make(0)
    const now = options.now ?? (() => new Date())
    const margin = (options.config.renewBeforeSeconds ?? 60) * 1000
    const fresh = (token: SamlToken | undefined): token is SamlToken =>
      token !== undefined &&
      (token.notOnOrAfter === undefined || token.notOnOrAfter.getTime() - margin > now().getTime())
    return {
      current: Effect.gen(function* () {
        const cached = yield* Ref.get(cache)
        if (fresh(cached)) {
          return cached
        }
        const token = yield* fetchSamlToken(options)
        yield* Ref.set(cache, token)
        yield* Ref.update(count, (n) => n + 1)
        return token
      }),
      fetches: Ref.get(count)
    }
  })
