# ADR 0024: SOAP Transport Trust And Tokens Stay In The Profile

Status: Accepted · Date: 2026-10-03

## Context

The soap-ace flows call an ESB through their own `SoapTransport` on
`node:https` (mTLS, Basic, Bearer, a WS-Security UsernameToken). Inside a
bank network that was not enough: some hosts are reachable only through a
corporate proxy while the ESB must be called directly; the ESB's chain is
anchored on a private CA, or the certificate is self-signed, and the
profile's `tls.ca` replaced Node's roots instead of adding to them; and
the ESB wants a SAML bearer token issued by an STS, found in the STS reply
and carried in every call's Security header. Test, UAT and production
differ in all three, and the single `auth.json` per service could hold one.

## Decision

1. **One profile file per environment.** `auth.<env>.json` beside
   `auth.json`, selected by `LLM4TS_SOAP_ENV` or `-- --env`; a named
   environment without a file is an error, never a silent fallback. Every
   flow prints the file it loaded.
2. **Proxies are explicit, per side, never inherited.** `proxy: {url,
noProxy, auth}` on `fetch`, `call` and `sts`, or `"none"`; the transport
   opens an HTTP CONNECT tunnel and runs TLS over it. Proxy environment
   variables are not read; `check` names them as set-and-ignored.
3. **CA material adds to the system roots.** `tls.ca` (a PEM file) and
   `tls.caDir` (a directory of PEMs) are appended to `tls.rootCertificates`;
   `tls.trust: "ca-only"` restores the strict meaning. Pinned material is
   trusted as captured (`allowPartialTrustChain`), so a leaf whose issuer the
   server never sends still verifies. `rejectUnauthorized` is never turned
   off for a call.
4. **Trust on first use, with a visible fingerprint.** `trust <side>`
   reads the chain the endpoint presents through a connection that sends
   nothing (`peerChain`, the only unverified connection the kit makes),
   prints subject, issuer, validity and SHA-256 per certificate, asks, and
   on yes writes `trust/<host>.pem` and points the side's `tls.ca` at it.
   A chain the system already trusts is reported and nothing is written; a
   changed certificate is shown as a replacement and asked again.
5. **The STS request is a template the user owns.** `sts init` writes a
   WS-Trust 1.3 Issue envelope with placeholders; the kit only fills them.
   Any STS dialect is an edit of that file, not a code change.
6. **The token is carried as bytes.** The first element named
   `sts.token.element` (default `Assertion`) is sliced from the response
   text by the parser's span and inserted unchanged, so a signature over
   it survives; it is held in memory for the run, renewed
   `renewBeforeSeconds` before `Conditions/@NotOnOrAfter`, never persisted.
   The Security header order is Timestamp, UsernameToken, token.

## Consequences

- The three kinds of failure now have names: `TransportError` reason
  `proxy`, reason `tls` with the `trust` hint on an unknown issuer, and
  `StsError` with the fault or the element it looked for.
- Holder-of-key tokens, XML signing by the client, a general XPath and
  reading proxy variables remain out of scope.
- Divergence from the pinned llm4zio (which has no SOAP kit) is noted in
  `docs/parity.md`.
