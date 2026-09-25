import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { SoapVersion } from "./Catalog.ts"
import type { ResolvedUsernameToken } from "./Auth.ts"
import {
  elements,
  escapeAttribute,
  escapeText,
  firstChild,
  is,
  textOf,
  type XmlElement,
  type XmlNode
} from "./Xml.ts"

// SOAP envelopes: building a request around a body, the WS-Security
// UsernameToken header, reading a response (body or fault), and removing
// every security header before an exchange is persisted.

export const Soap11Namespace = "http://schemas.xmlsoap.org/soap/envelope/"
export const Soap12Namespace = "http://www.w3.org/2003/05/soap-envelope"
export const WsseNamespace =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
export const WsuNamespace =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
const TokenProfile =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0"
const Base64Binary =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"

export const envelopeNamespace = (version: SoapVersion): string =>
  version === "1.1" ? Soap11Namespace : Soap12Namespace

/** HTTP headers a SOAP request carries for its version. */
export const soapHeaders = (
  version: SoapVersion,
  soapAction: string
): Readonly<Record<string, string>> =>
  version === "1.1"
    ? { "content-type": "text/xml; charset=utf-8", soapaction: `"${soapAction}"` }
    : {
        "content-type": `application/soap+xml; charset=utf-8${soapAction === "" ? "" : `; action="${escapeAttribute(soapAction)}"`}`
      }

export interface TokenMaterial {
  /** 16 random bytes. */
  readonly nonce: Uint8Array
  /** ISO 8601 UTC timestamp. */
  readonly created: string
}

/** `Base64(SHA-1(nonce + created + password))`, per the UsernameToken profile. */
export const passwordDigest = (material: TokenMaterial, password: string): string =>
  createHash("sha1")
    .update(Buffer.from(material.nonce))
    .update(material.created, "utf8")
    .update(password, "utf8")
    .digest("base64")

export const usernameTokenHeader = (
  token: ResolvedUsernameToken,
  material: TokenMaterial
): Redacted.Redacted<string> => {
  const password = Redacted.value(token.password)
  const passwordValue =
    token.passwordType === "digest" ? passwordDigest(material, password) : password
  const type = token.passwordType === "digest" ? "PasswordDigest" : "PasswordText"
  return Redacted.make(
    [
      `<wsse:Security xmlns:wsse="${WsseNamespace}" xmlns:wsu="${WsuNamespace}" soapenv:mustUnderstand="1">`,
      '<wsse:UsernameToken wsu:Id="UsernameToken-1">',
      `<wsse:Username>${escapeText(token.user)}</wsse:Username>`,
      `<wsse:Password Type="${TokenProfile}#${type}">${escapeText(passwordValue)}</wsse:Password>`,
      `<wsse:Nonce EncodingType="${Base64Binary}">${Buffer.from(material.nonce).toString("base64")}</wsse:Nonce>`,
      `<wsu:Created>${material.created}</wsu:Created>`,
      "</wsse:UsernameToken>",
      "</wsse:Security>"
    ].join("")
  )
}

/**
 * Wrap a body element (serialized XML, carrying its own namespace
 * declarations) in an envelope. The header, when present, is secret
 * material and so is the whole envelope that includes it.
 */
export const buildEnvelope = (
  version: SoapVersion,
  body: string,
  header?: Redacted.Redacted<string>
): Redacted.Redacted<string> =>
  Redacted.make(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<soapenv:Envelope xmlns:soapenv="${envelopeNamespace(version)}">`,
      header === undefined ? "" : `<soapenv:Header>${Redacted.value(header)}</soapenv:Header>`,
      `<soapenv:Body>${body}</soapenv:Body>`,
      "</soapenv:Envelope>"
    ].join("")
  )

export class EnvelopeError extends Schema.TaggedError<EnvelopeError>()("EnvelopeError", {
  detail: Schema.String
}) {
  get message(): string {
    return `SOAP envelope: ${this.detail}`
  }
}

export class SoapFault extends Schema.Class<SoapFault>("SoapFault")({
  code: Schema.String,
  reason: Schema.String,
  /** Local name of the detail's first element, e.g. `ServizioFault`. */
  detailElement: Schema.optionalKey(Schema.String)
}) {}

export interface ReadEnvelope {
  readonly version: SoapVersion
  /** The first element inside `Body` (the response or the fault). */
  readonly payload: XmlElement | undefined
  readonly fault: SoapFault | undefined
}

export const readEnvelope = (root: XmlElement): Effect.Effect<ReadEnvelope, EnvelopeError> =>
  Effect.suspend(() => {
    const read = readEnvelopeSync(root)
    return read instanceof EnvelopeError ? Effect.fail(read) : Effect.succeed(read)
  })

const readEnvelopeSync = (root: XmlElement): ReadEnvelope | EnvelopeError => {
  const version: SoapVersion | undefined = is(root, Soap11Namespace, "Envelope")
    ? "1.1"
    : is(root, Soap12Namespace, "Envelope")
      ? "1.2"
      : undefined
  if (version === undefined) {
    return new EnvelopeError({
      detail: `root is {${root.name.namespace}}${root.name.local}, not a SOAP Envelope`
    })
  }
  const namespace = envelopeNamespace(version)
  const body = firstChild(root, namespace, "Body")
  if (body === undefined) return new EnvelopeError({ detail: "envelope has no Body" })
  const payload = elements(body)[0]
  if (payload === undefined || !is(payload, namespace, "Fault")) {
    return { version, payload, fault: undefined }
  }
  const unqualified = (local: string) =>
    elements(payload).find((child) => child.name.local === local)
  const deep = (element: XmlElement | undefined, ...path: ReadonlyArray<string>) =>
    path.reduce<XmlElement | undefined>(
      (current, local) =>
        current === undefined
          ? undefined
          : elements(current).find((child) => child.name.local === local),
      element
    )
  const fault =
    version === "1.1"
      ? new SoapFault({
          code: textOf(unqualified("faultcode") ?? payload).trim(),
          reason: textOf(unqualified("faultstring") ?? payload).trim(),
          ...detailOf(unqualified("detail"))
        })
      : new SoapFault({
          code: textOf(deep(payload, "Code", "Value") ?? payload).trim(),
          reason: textOf(deep(payload, "Reason", "Text") ?? payload).trim(),
          ...detailOf(unqualified("Detail"))
        })
  return { version, payload, fault }
}

const detailOf = (detail: XmlElement | undefined) => {
  const first = detail === undefined ? undefined : elements(detail)[0]
  return first === undefined ? {} : { detailElement: first.name.local }
}

/** Remove every WS-Security header block (any version of the wsse namespace). */
export const stripSecurity = (root: XmlElement): XmlElement => {
  const isSecurity = (node: XmlNode): boolean =>
    node._tag === "element" &&
    node.name.local === "Security" &&
    /wss|secext/i.test(node.name.namespace)
  const walk = (element: XmlElement): XmlElement => ({
    ...element,
    children: element.children
      .filter((child) => !isSecurity(child))
      .map((child) => (child._tag === "element" ? walk(child) : child))
  })
  return walk(root)
}

const sensitiveHeader =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$|token|secret|password|session|auth/i

/** Response and request headers safe to persist. */
export const safeHeaders = (
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !sensitiveHeader.test(name))
      .map(([name, value]) => [name.toLowerCase(), value])
  )
