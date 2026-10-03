# soap-ace: environments, proxies, trust and STS tokens

Date: 2026-10-03. Status: approved in conversation, implementing.

## Intent

The soap flows (`soap-sample` first; `soap-explore`'s probe and
`soap-discover`'s WSDL fetch through the same transport and profile) must
reach an ESB inside a bank network where Node's defaults fail three ways:
a corporate proxy some hosts need and the ESB must not use; a TLS chain
anchored on a private CA or a self-signed certificate; and endpoints that
require a WS-Security header carrying a SAML token obtained from an STS
with configured credentials. All of it differs per environment. The
generated client in the target application is out of scope.

Decisions made in conversation: proxies are explicit per side with a
no-proxy list, never read from the environment; CA PEMs add to the system
roots, and a `trust` command captures a server's chain on first use behind
a visible fingerprint (no "verify: false" option); the STS request is a
template the user owns, seeded by `sts init` with a standard WS-Trust 1.3
Issue; the token is a bearer SAML assertion inserted as-is; the token is
found by element name (default `Assertion`, first match, any namespace) and
carried as the raw bytes of the response so a signature survives; one
profile file per environment, `auth.<env>.json`, selected by
`LLM4TS_SOAP_ENV` or `-- --env`.

## Profile

`.llm4ts/soap/<service>/auth.<env>.json` is a complete profile; `auth.json`
is the default. Every flow prints which file it loaded. New fields, each
optional, on every side (`fetch`, `call`, `sts`):

- `proxy`: `{ "url": "http://proxy:3128", "noProxy": ["esb.bank.local",
"*.internal"], "auth": {basic, refs} }` or `"none"` (default).
- `tls.ca`: a PEM file or a directory of PEMs, added to the system roots.
  `tls.trust: "system+ca" | "ca-only"` (default `system+ca`).
  `tls.servername`.
- `sts` (profile level): `{ "endpoint", "soapVersion", "template":
"sts.request.xml", "auth": { "user", "password" }, "appliesTo", "token":
{ "element": "Assertion" }, "renewBeforeSeconds": 60, "timestamp": true,
"proxy", "tls" }`. When present every `call` carries the token;
  `wsSecurity` (UsernameToken) may coexist.

## Transport

`SoapHttpRequest` gains `proxy` and a richer `tls`. The Node transport:
an HTTP CONNECT tunnel to the proxy, then TLS over the socket via
`createConnection`; no-proxy matched on the target host with `*.`
wildcards; a refused tunnel is `TransportError` reason `proxy` with the
proxy's status, never its credentials. CA = system roots + profile PEMs
(`tls.rootCertificates`), `servername` when set, `rejectUnauthorized`
always true. A `peerChain(url, options)` primitive connects once without
verification, reads the presented chain (subject, issuer, validity,
SHA-256 fingerprint, PEM), sends nothing, and is used only by `trust`.
The fake transport records proxy and tls per request.

## Commands (soap-sample)

- `"check"`: the selected profile file, each side's endpoint, proxy
  decision and CA sources, STS configured and template present, proxy
  environment variables set and ignored. No network.
- `"trust call|fetch|sts"`: prints the chain, asks `trust this chain?
[y/N]` in a terminal (`-- --yes` headless), writes
  `trust/<host>.pem` (gitignored) and sets that side's `tls.ca` in the
  selected profile. Already trusted by the system: reported, nothing
  written. Changed fingerprint: old and new shown, asked again.
- `"sts init"`: writes `sts.request.xml` (WS-Trust 1.3 Issue, UsernameToken
  header, AppliesTo) with `{{username}}`, `{{password}}`, `{{created}}`,
  `{{expires}}`, `{{nonce}}`, `{{appliesTo}}`.
- `"call …"` with `sts` configured: fetches the token before the first
  call, renews before `NotOnOrAfter - renewBeforeSeconds`, keeps it in
  memory only, and sends `<wsse:Security>` with Timestamp (when on),
  UsernameToken (when set), then the assertion bytes.

## Errors and secrets

`StsError` (status, fault, "no Assertion in the response"); `tls` failures
on an unknown issuer say "run trust <side>"; proxy credentials, STS
credentials, the filled STS envelope and the token are `Redacted` end to
end and never persisted (exchanges already strip the Security header).

## Tests

Profile decoding and env selection; live loopback CONNECT proxy and
self-signed server (`it.live`, like the existing transport test); `trust`
over the fake transport; STS template fill, raw-byte extraction with odd
whitespace and a signature, renewal under `TestClock`, header order on the
wire; `check` output.

## Skill

`skills/configuring-soap-flows/SKILL.md`: when to use, the profile shape
per environment, the order of operations in a locked-down environment
(`check` → `trust` → `sts init` → `call`), what each error means, and what
never goes in a file.

## Docs and release

ADR 0024, kit README section and command list, RUNBOOK lines, CHANGELOG,
parity note; released as 2.28.0.

## Not in scope

Holder-of-key tokens and XML signing, a full XPath engine, reading proxy
environment variables, `verify: false`, the generated client.
