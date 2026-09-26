# Kit: soap-ace (SOAP service → REST API on IBM ACE 12)

New kit `kits/soap-ace/`: given a SOAP WSDL (file or URL, with auth when
needed) it builds a typed catalog of operations and types, helps the user
configure sample requests and capture masked responses, analyses them into
evidence, proposes a resource-oriented REST design grounded in a 1:1
traceability mapping, and plans the ACE 12 implementation as an epic run
through the `epic-stories` machinery.

Driver: in bank integration work most new REST APIs are exposed through IBM
ACE on top of an existing SOAP service. Today the team discovers the SOAP
contract by hand in SoapUI, guesses at real response behaviour, and designs
the REST API from the WSDL alone. The main value of this kit is the
discovery half — catalog, samples, analysis — so the design and the plan
rest on evidence instead of on the WSDL's promises.

Direction note: the existing `mainframe-java/ace-integration` pack treats
ACE as the legacy **source**; here ACE is the **target** and SOAP the source.
Nothing is shared with that pack.

## Decisions (agreed 2026-09-25)

| Decision          | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery         | Deterministic parser, never the LLM. WSDL 1.1/2.0 + XSD, following `wsdl:import`, `xsd:import`, `xsd:include` (file and URL). Output is a schema-validated `WsdlCatalog`. Constructs the parser does not model (`xsd:any`, substitution groups, unusual facets) become explicit **open-question flags** on the catalog, never guesses.                                                                                                                                                                                                                              |
| Binding scope     | document/literal (bare and wrapped) only in v1; RPC/encoded bindings fail with a typed error naming the binding. SOAP 1.1 and 1.2.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Auth              | Schemes: `none`, HTTP Basic, Bearer, mTLS (PEM or PKCS#12 + passphrase), WS-Security `UsernameToken` (PasswordText and PasswordDigest, calls only). Separately configurable for WSDL fetch and for calls.                                                                                                                                                                                                                                                                                                                                                           |
| Secrets           | A gitignored auth profile `.llm4ts/soap/<service>/auth.json` holds only references (`env:NAME`, `file:path`). Resolved values live only as `Redacted` inside the transport layer. Persisted exchanges have auth headers and `wsse:Security` stripped; tests assert it. Never in args, logs, traces, plans, or error messages.                                                                                                                                                                                                                                       |
| Environments      | The auth profile declares `environment: dev \| test \| uat`; any other value is refused, so an unlabelled production URL cannot slip in.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Call policy       | Each operation is classified `read` / `mutating` (name heuristic proposes, the `Judgment` service suggests with a probability, the human confirms in `.llm4ts/soap/<service>/operations.md`: the persisted file is the approval). Unclassified operations are not callable. `dev`: mutating calls allowed after an interactive confirmation; `test`/`uat`: mutating calls need `--allow-mutating <op>` (one named operation, no wildcard). Both defaults overridable in the profile. The classification also drives the REST verb in the design.                    |
| Sample sources    | (1) Synthesized requests called directly; (2) SoapUI/ReadyAPI project import. All samples land in one `SampleStore` tagged with their provenance and are validated against the catalog; a sample that violates the XSD is a **finding**, not a rejection. No recording proxy in v1.                                                                                                                                                                                                                                                                                 |
| Request authoring | Primary form: a YAML projection of the XSD per request (`samples/<op>/<name>.request.yaml`), required fields filled, optional ones commented with type, facets, and enumerations. Second form: raw `<name>.request.xml` envelope body, validated the same way. Values seeded from imported SoapUI samples, then LLM proposals, then XSD defaults. Each request carries a `purpose:` line.                                                                                                                                                                           |
| Scenario sets     | Per operation the reasoning seat proposes: happy path, empty result, pagination boundary, one business fault (`esito` KO), one schema edge (max length, optional fields omitted). The user edits and reruns.                                                                                                                                                                                                                                                                                                                                                        |
| Masking           | Always on, no switch. Deterministic `SampleMasker` runs before persistence and before any LLM sees a sample. Detection by XSD field name/type and by value (IBAN mod-97, PAN Luhn, codice fiscale checksum, partita IVA, email, phone). Format-preserving HMAC-keyed pseudonymization, stable within a service so cross-field relationships survive. Per-field `mask`/`keep` overrides; every masking decision reported. Raw data only in memory, or with `--keep-raw` in a gitignored `raw/` never shown to an LLM. v1 detectors: Italian set + PAN, email, phone. |
| Analysis          | Per operation `analysis/<op>.md` plus a typed JSON sidecar: field presence/emptiness statistics, observed enums and formats, `esito`/fault codes and their meanings, XSD violations, pagination behaviour, latency.                                                                                                                                                                                                                                                                                                                                                 |
| Design model      | Always emit the deterministic 1:1 mapping (every XSD path ↔ JSONPath) as the traceability base. The reasoning seat proposes a resource-oriented design as a typed overlay; every endpoint and field cites its SOAP operation, XSD path, and analysis evidence. OpenAPI 3.1 is **projected** deterministically from the approved design, never hand-written (same principle as ADR 0012). `SpecChecks` verifies every SOAP operation is covered, deliberately excluded, or merged.                                                                                   |
| Style guide       | No bank guide yet: the kit ships a default `api-style.md` (camelCase JSON, plural resource nouns, RFC 9457 problem details, cursor or page pagination chosen from observed behaviour, `/v1` path versioning, ISO 8601 dates, `{ amount: string, currency }` with ISO 4217). Hard constraint for the design and a judge rubric; a project-tier copy overrides it.                                                                                                                                                                                                    |
| ACE target        | ACE 12 (12.0.x LTS), ESQL for mapping. REST API project, one subflow per operation calling the backend via `SOAPRequest`, shared library for fault/`esito` → problem-details, policy project per environment (dev/test/uat: endpoints, mTLS, WS-Security).                                                                                                                                                                                                                                                                                                          |
| Gates             | Target scenario is a developer laptop with ACE installed: gate commands run `ibmint` and the ACE JUnit test framework through a wrapper that sources `mqsiprofile`. The official `ace` container image is an optional alternative gate profile. Backend stubbed with the masked samples as recorded responses. `llm4ts doctor` gains an ACE check (install found, `mqsiprofile` loads, `ibmint` version). llm4ts CI validates the pack with `modernize-pack-check` only.                                                                                            |
| Epic              | Reuse `epic-stories` (ADR 0013) — `implementStoriesFlow`, story DAG, disjoint `owned` sets, persisted plan is the approval, per-story worktrees, merge to `epic/<id>`. Story split derived deterministically from the approved design; the LLM only writes descriptions. Resource stories in parallel, concurrency default 2.                                                                                                                                                                                                                                       |
| Board, delivery   | Local `BoardSync` board by default; Azure DevOps mirror with `--board azure-devops` (ADR 0011), not default. Branches only: no PR, no merge.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Seats             | Reasoning seat (`claude` default, `LLM4TS_REASONER`) for scenarios, classification, and design; coder seat (`LLM4TS_CODER`) for ESQL. Seats wrapped with `EstimatedUsage` as in the convert flows; figures carry the estimate marker.                                                                                                                                                                                                                                                                                                                               |
| Placement         | Everything in the kit; `@llm4ts/core`, `flow`, `runner` unchanged. SOAP library in `kits/soap-ace/flows/lib/soap/`. Transport is a `SoapTransport` service with a `node:https` implementation (mTLS) and an in-src fake; core `HttpClient` is not widened. If a second kit ever needs the library, promoting it is an ADR.                                                                                                                                                                                                                                          |
| XML               | Strict in-kit reader `lib/soap/Xml.ts`, no dependency: elements, attributes, namespaces with prefix scoping, text, CDATA, comments, PIs, predefined entities and numeric references, decoding by declared encoding via `TextDecoder` (latin-1 estates). `<!DOCTYPE` rejected with a typed error — XXE and entity expansion impossible by construction. Used for WSDL, XSD, SOAP responses, and SoapUI projects.                                                                                                                                                     |
| Interaction       | File-first: every step reads and writes files under `.llm4ts/soap/<service>/`, editing a file is the approval and rerunning is the loop. `llm4ts shell` (ADR 0006) offers the same loop interactively via `Interaction` over the same files — a front end, not a second code path.                                                                                                                                                                                                                                                                                  |

## Kit layout

```text
kits/soap-ace/
  README.md                      one-line description first
  api-style.md                   default REST style guide
  packs/ace12-rest/              pack.md, prompts/, reviewers/, patterns/
  scaffolds/ace12-rest-api/      REST API project, shared lib, policy project, test project
  patterns/                      ESQL pattern cards (fault mapping, esito envelope, pagination, date/amount)
  flows/
    soap-discover.ts             catalog + open questions + operation classification proposal
    soap-sample.ts               scenario proposal, YAML/XML request authoring, call, SoapUI import
    soap-design.ts               analysis → 1:1 mapping → design overlay → OpenAPI projection
    soap-epic.ts                 story plan from the approved design → implementStoriesFlow
    lib/soap/                    Xml, Wsdl, Xsd, Envelope, Transport, Auth, Samples, Masking, SoapUiImport, Analysis, ApiDesign
  fixtures/demo-bank-soap/       synthetic service (see below)
  test/
```

## Workspace artifacts (`.llm4ts/soap/<service>/`)

| File                                     | Written by      | Approval semantics                                   |
| ---------------------------------------- | --------------- | ---------------------------------------------------- |
| `auth.json` (gitignored)                 | user            | references only                                      |
| `catalog.json`, `catalog.md`             | `soap-discover` | regenerated; open questions listed                   |
| `operations.md`                          | `soap-discover` | human confirms `read`/`mutating`; existing file wins |
| `samples/<op>/<name>.request.{yaml,xml}` | `soap-sample`   | user edits; rerun calls                              |
| `samples/<op>/<name>.exchange.json`      | `soap-sample`   | masked, auth-stripped, provenance-tagged             |
| `analysis/<op>.md` + `.json`             | `soap-design`   | regenerated from samples                             |
| `design/mapping.json`                    | `soap-design`   | deterministic 1:1 traceability                       |
| `design/api-design.md`                   | `soap-design`   | proposal; editing it is the approval                 |
| `design/openapi.yaml`                    | `soap-design`   | projected; never edited by hand or by the coder      |
| `epic-<hash>.md`                         | `soap-epic`     | story plan; existing file is used as is              |

## Demo epic shape

Stories generated from the approved design for `demo-bank-soap`:

| #   | Story             | Owns                                                                           | Depends on |
| --- | ----------------- | ------------------------------------------------------------------------------ | ---------- |
| 1   | `api-skeleton`    | REST API project, `restapi.descriptor`, projected OpenAPI (read-only to coder) | none       |
| 2   | `policies`        | policy project: endpoints and security for dev/test/uat                        | none       |
| 3   | `error-lib`       | shared library: SOAP fault / `esito` → problem details                         | none       |
| 4   | `backend-stub`    | test stubs replaying masked samples                                            | none       |
| 5…n | `resource-<name>` | per REST resource: subflows, ESQL modules, JUnit tests                         | 1, 2, 3, 4 |
| n+1 | `contract-check`  | end-to-end: every OpenAPI operation reachable and schema-conformant            | 5…n        |

## Fixture: demo-bank-soap

Synthetic, committed under `kits/soap-ace/fixtures/demo-bank-soap/`: WSDL 1.1
document/literal wrapped importing split XSDs (common types, conti,
movimenti, bonifici); operations `cercaConti`, `dettaglioConto`,
`cercaMovimenti` (paginated), `inserisciBonifico` and `confermaBonifico`
(mutating), `revocaBonifico`; SOAP faults plus an in-body `esito` envelope;
one latin-1 encoded XSD; one `xsd:any` extension point (open-question case);
one RPC/encoded binding in a separate WSDL (rejection case); a SoapUI
project with recorded requests/responses carrying synthetic IBAN IT and
codice fiscale values. A deterministic fake `SoapTransport` serves the
fixture for tests.

## Tasks

- [ ] Kit skeleton: `README.md`, `api-style.md`, registration so `llm4ts kits`
      lists it and its flows appear in `llm4ts list`.
- [ ] `Xml.ts`: strict reader with `<!DOCTYPE` rejection and encoding
      handling; tests including latin-1, CDATA, namespace scoping, and a
      DOCTYPE/entity-expansion attempt.
- [ ] `Wsdl.ts` / `Xsd.ts`: catalog with `Schema` types, import/include
      resolution (file + URL through `SoapTransport`), open-question flags,
      typed rejection of RPC/encoded.
- [ ] `Auth.ts` / `Transport.ts`: auth profile schema with `env:`/`file:`
      references, `Redacted` resolution, `node:https` transport with mTLS,
      WS-Security `UsernameToken` header, environment validation, in-src
      fake transport; tests that no secret reaches errors, logs, or
      persisted files.
- [ ] Operation classification: name heuristic, `Judgment` question and
      policy, `operations.md` persistence (existing file wins), call-policy
      enforcement per environment.
- [ ] `Masking.ts`: detectors (IBAN IT, codice fiscale, partita IVA, PAN,
      email, phone), XSD-name classification, HMAC format-preserving
      pseudonymization, overrides, masking report; property tests that
      masked IBAN/CF/PAN stay valid and are stable.
- [ ] `Envelope.ts` + request authoring: YAML projection of the XSD, raw XML
      form, validation of both, envelope rendering for SOAP 1.1/1.2.
- [ ] `Samples.ts` / `SoapUiImport.ts`: `SampleStore` (memory + file),
      provenance tags, XSD validation findings, SoapUI/ReadyAPI project
      import through the masker.
- [ ] `soap-discover` and `soap-sample` flows, including scenario-set
      proposal.
- [ ] `Analysis.ts`: per-operation statistics and findings, markdown + JSON
      sidecar.
- [ ] `ApiDesign.ts`: deterministic 1:1 mapping, typed design overlay with
      citations, OpenAPI 3.1 projection, coverage check through
      `SpecChecks`; `soap-design` flow with the style guide as constraint
      and judge rubric.
- [ ] `ace12-rest` pack, `ace12-rest-api` scaffold, ESQL pattern cards,
      `modernize-pack-check` passing; gate wrapper sourcing `mqsiprofile`;
      container gate profile; `llm4ts doctor` ACE check.
- [ ] `soap-epic` flow: deterministic story split from the approved design,
      `implementStoriesFlow` composition, local board, optional Azure DevOps
      mirror, concurrency default 2.
- [ ] `demo-bank-soap` fixture and an end-to-end deterministic test driving
      discover → sample (fake transport) → design → epic plan with fakes.
- [ ] Docs: kit README walkthrough, `kits/README.md` table row, a runbook
      for a developer laptop with ACE 12.

## Non-goals (v1)

RPC/encoded bindings; a recording proxy; WS-Security X.509 signing, SAML,
OAuth2 client credentials; vault integrations beyond `env:`/`file:`;
non-Italian PII detectors; Graphical Data Maps or Java Compute; ACE 13;
running ACE gates in llm4ts CI; pull requests or merges; promoting the SOAP
library out of the kit.
