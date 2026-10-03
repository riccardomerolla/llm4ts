import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import {
  type AuthProfile,
  type AuthProfileError,
  type HttpSide,
  type ProxySetting,
  resolveProxy,
  resolveTls,
  type SecretSource,
  type TlsConfig
} from "./Auth.ts"
import { profilePath, readIfPresent, servicePaths } from "./Discover.ts"
import { renderDefaultStsTemplate, stsTemplatePath, templatePlaceholders } from "./Sts.ts"
import {
  displayUrl,
  type PeerChain,
  type SoapTransportShape,
  type TransportError
} from "./Transport.ts"

// What a person runs before the first call in a locked-down environment:
// `check` reads the selected profile back as decisions (no network), `trust`
// captures the chain a side's endpoint presents and pins it after a visible
// fingerprint, `sts init` writes the STS request template. None of them
// sends an envelope.

export type SideName = "fetch" | "call" | "sts"

const proxyWords = (proxy: ProxySetting | undefined): string =>
  proxy === undefined || proxy === "none"
    ? "direct (no proxy)"
    : `via ${proxy.url}${(proxy.noProxy ?? []).length === 0 ? "" : `, direct for ${proxy.noProxy?.join(", ")}`}${proxy.auth === undefined ? "" : ", with proxy credentials"}`

const tlsWords = (tls: TlsConfig | undefined): string => {
  if (tls === undefined) {
    return "system roots"
  }
  const parts: Array<string> = []
  parts.push(
    tls.trust === "ca-only"
      ? "profile CA only"
      : tls.ca === undefined && tls.caDir === undefined
        ? "system roots"
        : "system roots + profile CA"
  )
  if (tls.ca !== undefined) parts.push(`ca ${tls.ca}`)
  if (tls.caDir !== undefined) parts.push(`caDir ${tls.caDir}`)
  if (tls.pfx !== undefined) parts.push("client pfx")
  if (tls.cert !== undefined) parts.push("client cert+key")
  if (tls.servername !== undefined) parts.push(`servername ${tls.servername}`)
  return parts.join(", ")
}

const authWords = (side: HttpSide | undefined): string =>
  side?.auth === undefined || side.auth.scheme === "none"
    ? "no auth"
    : side.auth.scheme === "basic"
      ? `basic as ${side.auth.user}`
      : "bearer"

/** The proxy variables of the environment, which the soap flows never read. */
export const ignoredProxyVariables = (
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> =>
  ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"].filter(
    (name) => (environment[name] ?? "").trim() !== ""
  )

export interface CheckOptions {
  readonly workspace: WorkspaceShape
  readonly service: string
  readonly env: string | undefined
  readonly profile: AuthProfile | undefined
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** `check`: the selected profile as the decisions it makes, line by line. No network. */
export const checkReport = (
  options: CheckOptions
): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
  Effect.gen(function* () {
    const path = profilePath(options.service, options.env)
    const lines: Array<string> = [
      `profile: ${path}${options.profile === undefined ? " (missing)" : ""}`
    ]
    const profile = options.profile
    if (profile === undefined) {
      lines.push(`  write it with at least {"environment": "dev"}; see the soap-ace README`)
    } else {
      lines.push(`environment: ${profile.environment}`)
      lines.push(`call endpoint: ${profile.endpoint ?? "(from the WSDL)"}`)
      for (const [name, side] of [
        ["fetch", profile.fetch],
        ["call", profile.call]
      ] as const) {
        lines.push(
          `${name}: ${authWords(side)}; ${proxyWords(side?.proxy)}; tls ${tlsWords(side?.tls)}`
        )
      }
      if (profile.wsSecurity !== undefined) {
        lines.push(`ws-security: UsernameToken (${profile.wsSecurity.passwordType})`)
      }
      if (profile.sts === undefined) {
        lines.push("sts: none")
      } else {
        const template = stsTemplatePath(options.service, profile.sts)
        const text = yield* readIfPresent(options.workspace, template)
        lines.push(
          `sts: ${displayUrl(profile.sts.endpoint)}; ${proxyWords(profile.sts.proxy)}; tls ${tlsWords(profile.sts.tls)}; token element ${profile.sts.token?.element ?? "Assertion"}`
        )
        lines.push(
          text === undefined
            ? `  template ${template} missing: write it with soap-sample "sts init"`
            : `  template ${template} fills ${templatePlaceholders(text).join(", ") || "(no placeholders)"}`
        )
      }
      const trust = yield* options.workspace.discover(
        `${servicePaths(options.service).trustDir}/*.pem`
      )
      if (trust.length > 0) {
        lines.push(`trusted chains: ${trust.map((file) => file.split("/").at(-1)).join(", ")}`)
      }
    }
    const ignored = ignoredProxyVariables(options.environment)
    if (ignored.length > 0) {
      lines.push(
        `ignored: ${ignored.join(", ")} are set; the soap flows use only the profile's proxy`
      )
    }
    return lines
  })

// ---------------------------------------------------------------------------
// trust

export class TrustError extends Schema.TaggedError<TrustError>()("TrustError", {
  side: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `trust ${this.side}: ${this.detail}`
  }
}

export interface TrustOptions {
  readonly workspace: WorkspaceShape
  readonly service: string
  readonly env: string | undefined
  readonly profile: AuthProfile
  readonly side: SideName
  /** The side's endpoint when the profile does not name one (the WSDL's address). */
  readonly fallbackEndpoint?: string
  readonly secrets: SecretSource
  readonly transport: SoapTransportShape
  /** Shown the chain; answers whether to pin it. */
  readonly confirm: (lines: ReadonlyArray<string>) => Effect.Effect<boolean>
}

export type TrustOutcome =
  | { readonly _tag: "AlreadyTrusted"; readonly lines: ReadonlyArray<string> }
  | { readonly _tag: "Declined"; readonly lines: ReadonlyArray<string> }
  | {
      readonly _tag: "Pinned"
      readonly lines: ReadonlyArray<string>
      readonly pem: string
      readonly profile: string
      readonly replaced: boolean
    }

const endpointOf = (
  profile: AuthProfile,
  side: SideName,
  fallback: string | undefined
): string | undefined => (side === "sts" ? profile.sts?.endpoint : (profile.endpoint ?? fallback))

const sideConfig = (
  profile: AuthProfile,
  side: SideName
): { tls?: TlsConfig; proxy?: ProxySetting } =>
  side === "sts"
    ? {
        ...(profile.sts?.tls === undefined ? {} : { tls: profile.sts.tls }),
        ...(profile.sts?.proxy === undefined ? {} : { proxy: profile.sts.proxy })
      }
    : {
        ...(profile[side]?.tls === undefined ? {} : { tls: profile[side]?.tls }),
        ...(profile[side]?.proxy === undefined ? {} : { proxy: profile[side]?.proxy })
      }

export const describeChain = (chain: PeerChain): ReadonlyArray<string> => [
  `${chain.host}: ${chain.certificates.length} certificate(s)${chain.trustedBySystem ? ", trusted by the system roots" : `, NOT trusted by the system roots (${chain.authorizationError ?? "unknown issuer"})`}`,
  ...chain.certificates.flatMap((certificate, index) => [
    `  ${index + 1}. ${certificate.subject}`,
    `     issuer: ${certificate.issuer}`,
    `     valid: ${certificate.validFrom} → ${certificate.validTo}`,
    `     sha256: ${certificate.fingerprint256}`
  ])
]

const pemFileFor = (service: string, host: string): string =>
  `${servicePaths(service).trustDir}/${host.replace(/[^A-Za-z0-9.-]+/g, "_")}.pem`

/** Sets `<side>.tls.ca` in the selected profile's JSON text to the pinned file, keeping everything else. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const profileWithPinnedCa = (
  text: string,
  side: SideName,
  pemPath: string
): Effect.Effect<string, TrustError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed)) {
        throw new Error("not an object")
      }
      const sideValue = parsed[side]
      const sideObject: Record<string, unknown> = isRecord(sideValue) ? sideValue : {}
      const tlsValue = sideObject["tls"]
      const tlsObject: Record<string, unknown> = isRecord(tlsValue) ? tlsValue : {}
      const edited: Record<string, unknown> = {
        ...parsed,
        [side]: { ...sideObject, tls: { ...tlsObject, ca: `file:${pemPath}` } }
      }
      return `${JSON.stringify(edited, null, 2)}\n`
    },
    catch: () =>
      new TrustError({ side, detail: "the profile is not a JSON object; set tls.ca by hand" })
  })

/** `trust <side>`: show the chain, pin it on a yes. */
export const trustSide = (
  options: TrustOptions
): Effect.Effect<TrustOutcome, TrustError | TransportError | AuthProfileError | WorkspaceError> =>
  Effect.gen(function* () {
    const endpoint = endpointOf(options.profile, options.side, options.fallbackEndpoint)
    if (endpoint === undefined) {
      return yield* new TrustError({
        side: options.side,
        detail:
          options.side === "sts"
            ? "the profile names no sts"
            : "no endpoint in the profile or the WSDL"
      })
    }
    const config = sideConfig(options.profile, options.side)
    const proxy = yield* resolveProxy(options.secrets, config.proxy)
    const tls = yield* resolveTls(options.secrets, config.tls)
    const chain = yield* options.transport.peerChain(endpoint, {
      ...(proxy === undefined ? {} : { proxy }),
      ...(tls?.servername === undefined ? {} : { servername: tls.servername }),
      timeout: Duration.seconds(20)
    })
    const lines = describeChain(chain)
    if (chain.trustedBySystem) {
      return { _tag: "AlreadyTrusted", lines }
    }
    if (chain.certificates.length === 0) {
      return yield* new TrustError({
        side: options.side,
        detail: "the server presented no certificate"
      })
    }
    const pemPath = pemFileFor(options.service, chain.host)
    const existing = yield* readIfPresent(options.workspace, pemPath)
    const shown =
      existing === undefined
        ? lines
        : [
            ...lines,
            `a chain for ${chain.host} is already pinned at ${pemPath}; this one replaces it`
          ]
    if (!(yield* options.confirm(shown))) {
      return { _tag: "Declined", lines: shown }
    }
    yield* options.workspace.write(pemPath, chain.certificates.map((c) => c.pem).join(""))
    const profileFile = profilePath(options.service, options.env)
    const text = (yield* readIfPresent(options.workspace, profileFile)) ?? "{}"
    yield* options.workspace.write(
      profileFile,
      yield* profileWithPinnedCa(text, options.side, pemPath)
    )
    return {
      _tag: "Pinned",
      lines: shown,
      pem: pemPath,
      profile: profileFile,
      replaced: existing !== undefined
    }
  })

// ---------------------------------------------------------------------------
// sts init

/** `sts init`: the default template, unless one exists. */
export const initStsTemplate = (
  workspace: WorkspaceShape,
  service: string,
  profile: AuthProfile
): Effect.Effect<
  { readonly path: string; readonly written: boolean },
  WorkspaceError | TrustError
> =>
  Effect.gen(function* () {
    if (profile.sts === undefined) {
      return yield* new TrustError({
        side: "sts",
        detail: 'the profile names no "sts"; add it first'
      })
    }
    const path = stsTemplatePath(service, profile.sts)
    if ((yield* readIfPresent(workspace, path)) !== undefined) {
      return { path, written: false }
    }
    yield* workspace.write(path, renderDefaultStsTemplate(profile.sts.soapVersion ?? "1.1"))
    return { path, written: true }
  })
