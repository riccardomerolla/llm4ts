---
name: configuring-soap-flows
description: Use when running llm4ts's soap-ace flows (soap-discover, soap-sample, soap-explore, soap-design, soap-epic) against a real ESB and something about the environment stands in the way — a corporate proxy, a private or self-signed CA, a WS-Security UsernameToken or a SAML token from an STS, credentials, several environments (test, uat) of one service — or when asked to set up `.llm4ts/soap/<service>/auth.json`.
---

# Configuring the soap flows

The soap-ace kit (`llm4ts run soap-*`) calls an ESB through its own
transport. Everything about reaching the ESB lives in one profile file per
environment under the service folder; the flows read it and never the
environment's proxy variables. Your job is to get the profile right, in the
order below, and to read the typed errors literally: each one names the
next command.

## Order of operations in a locked-down environment

Run from the repository where `soap-discover` wrote `.llm4ts/soap/<service>/`.
Pick the environment with `LLM4TS_SOAP_ENV=<env>` or `-- --env <env>`; its
file is `auth.<env>.json`, `auth.json` is the default.

1. **Write the profile** (shape below). References only: `env:NAME` or
   `file:path` where a secret belongs. A literal secret is refused when
   the file is read.
2. **`llm4ts run soap-sample --repo . "check"`** — no network. Confirm the
   file it selected, each side's proxy decision and CA sources, the STS
   and its template, and the proxy variables it says it ignores. Fix the
   profile until the lines read as intended.
3. **`"trust call"`**, then **`"trust sts"`** when the profile names an
   STS, and **`"trust fetch"`** when the WSDL comes from a URL. Each
   prints the chain the endpoint presents with SHA-256 fingerprints and
   whether the system already trusts it. Compare the fingerprint with
   what the bank gave you before answering `y`; headless, add `-- --yes`.
   On yes the chain is pinned under `trust/` and the side's `tls.ca` is
   set. "Already trusted" means nothing to do.
4. **`"sts init"`** when the profile names an STS: writes
   `sts.request.xml`, a WS-Trust 1.3 Issue envelope. Compare it with the
   request the bank's SoapUI project sends and edit it to match; the kit
   fills only `{{username}}`, `{{password}}`, `{{created}}`,
   `{{expires}}`, `{{nonce}}`, `{{appliesTo}}`.
5. **`"call <operation>/<name>"`** on a read operation. The run prints the
   profile it used and, with an STS, how many token calls it made.

Done when a read operation answers with `HTTP 200` or a business fault and
`check` shows no missing piece. Only then move to `call all`,
`soap-explore`, or mutating operations.

## The profile

```json
{
  "environment": "uat",
  "endpoint": "https://esb-uat.bank.internal/soap/Service",
  "fetch": {
    "proxy": { "url": "http://proxy.bank.internal:3128", "noProxy": ["*.bank.internal"] }
  },
  "call": {
    "proxy": "none",
    "auth": { "scheme": "basic", "user": "svc", "password": "env:ESB_PASSWORD" },
    "tls": { "ca": "file:.llm4ts/soap/Service/trust/esb-uat.bank.internal.pem" }
  },
  "wsSecurity": { "user": "env:WS_USER", "password": "env:WS_PASSWORD", "passwordType": "digest" },
  "sts": {
    "endpoint": "https://sts-uat.bank.internal/trust/13/usernamemixed",
    "auth": { "user": "env:STS_USER", "password": "env:STS_PASSWORD" },
    "appliesTo": "https://esb-uat.bank.internal/soap/Service",
    "token": { "element": "Assertion" },
    "renewBeforeSeconds": 60,
    "timestamp": true
  }
}
```

- `proxy` per side (`fetch`, `call`, `sts`): an explicit CONNECT proxy with
  the hosts that bypass it (`*.suffix`), or `"none"`. Proxy credentials go
  in `proxy.auth` as references.
- `tls.ca` (PEM file) and `tls.caDir` (directory) add to the system roots;
  `tls.trust: "ca-only"` trusts only them; `tls.servername` for a host
  behind a front door; `pfx`+`passphrase` or `cert`+`key` for mTLS.
- `sts`: the token is a SAML bearer assertion inserted byte for byte after
  the Timestamp and the UsernameToken. `token.element` is the element name
  the STS reply carries (any namespace); set it when the reply is not a
  SAML `Assertion`.
- Every section is optional; an environment without security keeps only
  `environment` and `endpoint`.

The kit README, section "Environments, proxies, trust and STS tokens", is
the full reference; ADR 0024 holds the reasoning.

## Reading the errors

- `tls: … capture it with soap-sample "trust <side>"` — the chain is not
  trusted; run `trust` for that side.
- `proxy: HTTP 407` — the proxy wants credentials: `proxy.auth`.
  `proxy: HTTP 403` or `network` through a proxy — the host must bypass it:
  add it to `noProxy`, or the proxy is for another side.
- `STS …: no Assertion element in the response` — set `sts.token.element`
  to what the STS actually returns; read the response shape from the
  bank's documentation, never log the token.
- `STS …: fault …` — the template or the credential: compare
  `sts.request.xml` with the bank's working request.
- `auth profile: auth.<env>.json: invalid profile (at …)` — the path named
  is wrong or holds a literal secret.
- `no profile for environment '<env>'` — the file is missing for the
  environment you selected.

## What never goes in a file

Secret values (passwords, tokens, passphrases), the token the STS issued,
the filled STS envelope, raw unmasked responses outside the gitignored
`raw/`. `auth*.json`, `trust/`, `raw/` and `.masking-key` are gitignored by
discovery; keep them that way.
