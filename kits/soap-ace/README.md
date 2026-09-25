# Kit: soap-ace

SOAP services to REST APIs on IBM ACE 12: discover the WSDL, sample and analyse real responses, design the REST contract, and plan the ACE build as an epic.

In bank integration work most new REST APIs are exposed through IBM ACE on
top of an existing SOAP service. This kit turns a WSDL (a file or URL, with
auth when needed) into evidence first, then into a design, and only then into
an ACE implementation plan. The spec of record is
[`specs/pending/soap-ace-kit.md`](../../specs/pending/soap-ace-kit.md).

Direction: SOAP is the source and ACE the **target**. The
`mainframe-java/ace-integration` pack goes the other way (ACE as legacy
source) and shares nothing with this kit.

## Status

| Piece                                              | State    |
| -------------------------------------------------- | -------- |
| Strict XML reader (`flows/lib/soap/Xml.ts`)        | done     |
| WSDL 1.1/2.0 + XSD catalog (`Wsdl.ts`, `Xsd.ts`)   | done     |
| `demo-bank-soap` fixture                           | WSDL/XSD |
| `soap-discover` flow and operation classification  | pending  |
| Masking, auth profile, transport, sample authoring | pending  |
| Analysis, REST design, OpenAPI projection          | pending  |
| `ace12-rest` pack, scaffold, `soap-epic`           | pending  |

## soap-discover

```bash
llm4ts run soap-discover --repo ~/work/conti-api ./wsdl/DemoBank.wsdl
```

Writes under `<repo>/.llm4ts/soap/<service>/`:

| File            | What it is                                                               |
| --------------- | ------------------------------------------------------------------------ |
| `catalog.json`  | the typed catalog every later step reads                                 |
| `catalog.md`    | human summary: endpoints, operations and their fields, open questions    |
| `operations.md` | proposed `read`/`mutating` classes; review, then set `Status: confirmed` |

`operations.md` is the approval file: until its status is `confirmed` every
operation counts as unclassified, so nothing can be called and the design
cannot pick REST verbs. An existing file is never overwritten; rerunning
reports operations it does not mention and entries no longer in the WSDL.
Classes are proposed by a name heuristic (Italian and English verbs) and, when
`LLM4TS_JUDGMENT_PROVIDER` names a judgment seat, by a typed judgment
(ADR 0017); without one, discovery makes no model call at all.
`LLM4TS_SOAP_SERVICE` overrides the service directory name; for a WSDL URL it
also selects the auth profile whose `fetch` side authenticates every document
request.

## Discovery guarantees

- The catalog is produced by code, never by a model. Every operation, type,
  and field it lists is read from the WSDL and the schemas it imports.
- Constructs the reader does not model (`xs:any`, substitution groups,
  model-group refs, complex restrictions, list/union types, dangling
  references) are listed as **open questions** with their document and line.
- Only document/literal SOAP bindings (bare and wrapped, SOAP 1.1 and 1.2)
  become operations. A WSDL whose every binding is RPC or encoded is refused
  with an error naming the bindings; a WSDL that also offers a
  document/literal binding keeps it and lists the others as open questions.
- `<!DOCTYPE` is refused outright: no external entities, no entity expansion.
  Schemas in ISO-8859-1 and windows-1252 are decoded by their declaration.

## soap-sample

Runs after `soap-discover` in the same repository; the task text is a
command.

```bash
llm4ts run soap-sample --repo . "import ./DemoBank-soapui-project.xml"   # requests + mock responses, masked
llm4ts run soap-sample --repo . "init cercaMovimenti fine-mese"          # commented skeleton to edit
llm4ts run soap-sample --repo . "propose cercaMovimenti"                 # scenario set from the reasoning seat
llm4ts run soap-sample --repo . "call cercaMovimenti"                    # every request of the operation
llm4ts run soap-sample --repo . -- --allow-mutating revocaBonifico "call revocaBonifico/gia-eseguito"
llm4ts run soap-sample --repo . list
```

A request is a YAML projection of the XSD, one file per scenario under
`samples/<operation>/<name>.request.yaml`:

```yaml
# cercaMovimenti: fine mese
operation: cercaMovimenti
purpose: "fine mese"
body:
  iban: IT12L0542811101309953525271 # IbanType, string, pattern …, length 27 [1]
  dataDa: 2026-01-15 # date [1]
  dataA: 2026-01-15 # date [1]
  paginazione: # PaginazioneRichiesta [1]
    numeroPagina: 1 # int [1]
    dimensionePagina: 1 # int, 1..100 [1]
```

Required fields come filled with values that satisfy the schema: identifiers
already seen in earlier (masked) samples first, then checksummed example
IBANs and codici fiscali, enumeration values, and strings built from the XSD
patterns. Optional fields and choice alternatives are commented out. Every
value is a string, sent exactly as written; `~` sends `xsi:nil`. A raw
`<name>.request.xml` (the body element or a whole envelope, with an optional
`<!-- purpose: … -->`) is accepted as a second form and validated the same way.

`call` never sends a request that does not validate; it lists what to fix.
It records `<name>.exchange.json` beside the request: the masked request
and response envelopes without security headers, safe HTTP headers, status,
latency, any SOAP fault, and every place the response breaks its schema
(values outside an enumeration, undeclared elements), which are findings for
the design rather than errors. `--keep-raw` also writes the unmasked response
to the gitignored `raw/`, never shown to a model.

`propose` asks the reasoning seat (`LLM4TS_REASONER`, default `claude`) for
three to six scenarios (happy path, empty result, pagination boundary, a
business error, a schema edge) and writes each as a request file, listing
at its top whatever does not validate. `import` reads the requests saved in a
SoapUI or ReadyAPI project (interface calls and test steps) and its mock
responses; stored credentials are counted and ignored, and everything is
masked before it is written. `LLM4TS_SOAP_STUB=<dir>` answers calls from
`<dir>/<operation>.xml` instead of the network, for rehearsals; the fixture's
`responses/` directory is one.

## soap-design

```bash
llm4ts run soap-design --repo . "analyse"     # evidence per operation (no model)
llm4ts run soap-design --repo . mapping       # the 1:1 XSD ↔ JSON mapping (no model)
llm4ts run soap-design --repo . design        # the reasoning seat drafts design/api-design.md
llm4ts run soap-design --repo . check         # deterministic review; rerun after every edit
llm4ts run soap-design --repo . revise        # redraft against the check's findings
llm4ts run soap-design --repo . openapi       # design/openapi.yaml from an approved design
```

### analyse

Reads the recorded exchanges (calls and SoapUI mocks) and writes
`analysis/<operation>.md` with a typed `analysis/<operation>.json` beside it.
No model is involved; the report is the evidence the REST design must cite:

- **observations**: values outside a declared enumeration, undeclared code
  lists, required fields that are always empty, optional ones always present,
  `xsi:nil` usage, business errors carried inside successful responses,
  faults, and how many declared fields were never observed;
- **business outcome codes** (`esito.codice` and similar) with their
  descriptions and the samples that produced them;
- **SOAP faults** by code, detail element, and reason;
- **pagination**: page-number, offset, or cursor style, from the request and
  response field names, plus what the samples showed (last-page flags, most
  items per response);
- **response fields**: presence, emptiness and nil counts, and the masked
  values seen (most frequent first);
- **schema findings**: every place a response broke its WSDL;
- fields **never observed**, optional **request fields no sample used**,
  and **latency** across real calls.

### mapping, design, check, openapi

`mapping` writes `design/mapping.json` and `mapping.md`: every request and
response field with the JSON path and type a literal facade would use
(decimals stay strings). It is the traceability base: the only paths a
design may cite.

`design` asks the reasoning seat (`LLM4TS_REASONER`, default `claude`) for a
resource-oriented design, giving it the style guide as hard rules, the
confirmed classes, the mapping, the named XSD types, and the analysis
evidence. The draft is written to `design/api-design.md` under
`Status: proposed`, with the check's findings above the design of record, a
` ```json apidesign ` block:

- **endpoints** name their SOAP `sources`, parameters cite request paths,
  responses name a model and the response path it comes from (`list`/`paged`
  for collections), **errors** list the outcome codes and fault elements they
  map, and **evidence** cites the analysis;
- **models** bind to an XSD element or named type (`sourceType`); each
  property cites a path within it (`saldo.valore`) or a `derivation`, and an
  `enumMap` translates SOAP values to REST values;
- **excluded** lists operations deliberately not exposed, with reasons.

`check` is the deterministic reviewer, run on every draft and after every
edit. Errors: an operation neither exposed nor excluded, `GET` over a
mutating operation, a source path that is not in the XSD, a model rendered
from a type it is not bound to, an `enumMap` missing a declared value or a
value the samples showed (`SOSPESO`), and style violations (paths, names,
`esito` in payloads, problem codes). Warnings: REST promising a field the
XSD leaves optional, business errors or faults seen in samples but not
mapped, unused models. `revise` hands the findings back to the seat.

The file is the approval: edit the JSON block, rerun `check`, and set
`Status: approved`. `design` never overwrites it. `openapi` refuses a design
that is not approved or still has errors, then projects `design/openapi.yaml`
(OpenAPI 3.1): component schemas per model, `{ items, page }` wrappers for
collections, RFC 9457 problems per error status with their codes
(`x-problem-codes`), a `Location` header on creations, a default `502`, and
`x-soap-*` extensions tracing every operation, parameter, and property to the
SOAP service. Nobody edits it; the ACE pack implements it. The fixture's
[`design/api-design.md`](fixtures/demo-bank-soap/design/api-design.md) is a
reviewed example.

## soap-epic

```bash
llm4ts run soap-epic --repo . doctor                                # ACE 12 usable here?
llm4ts run soap-epic --repo . -- --target ~/work/demo-bank-ace plan # seed + story plan
```

`plan` takes an approved design with no check errors and prepares the ACE
repository (`--target`, a git repository):

- **regenerated every run**: `contracts/` (the design, `openapi.yaml` 3.1,
  `openapi-ace.yaml` 3.0.3 because ACE 12 imports OpenAPI 3.0, the 1:1
  mapping, the WSDL and XSDs re-encoded as UTF-8), `test-data/` (the masked
  exchanges the backend stubs are built from), `docs/analysis/`, and
  `docs/patterns/` (the ESQL pattern cards);
- **created once, then the team's**: the
  [`ace12-rest-api`](scaffolds/ace12-rest-api) scaffold: README,
  `CONTRIBUTING.md` (house rules every coder reads), and
  `scripts/ace-gates.sh build | test` (`ibmint package`; `ibmint deploy` to a
  scratch work directory and `IntegrationServer --test-project`, after
  sourcing `mqsiprofile`), plus a container variant.

It then derives the story plan, not generates it: `api-skeleton` (REST API
project descriptors and main flow), `policies` (dev/test/uat endpoints and
security), `shared-lib` (WSDL, backend call, error mapping), `backend-stub`
(test project and stubs), one `resource-<name>` story per resource owning its
broker schema folder and tests, and `contract-check`. The plan is saved where
the engine's `epic-stories` flow looks for it
(`.llm4ts/epics/<epic-id>/plan.md`, same epic id), so that flow executes it
unchanged: parallel stories in worktrees (concurrency 2), the ACE gates,
the judge, the board, branches only. An existing plan is kept; editing it is
the re-plan. `plan` prints the exact `epic-stories` command.

The [`ace12-rest`](packs/ace12-rest/pack.md) pack names the same gates and
the judge's rubric (contract, mapping, errors); its prompt and reviewer
sidecars carry the same rules as `CONTRIBUTING.md`.

## Auth profile

`.llm4ts/soap/<service>/auth.json` is gitignored (discovery writes the
directory's `.gitignore`) and holds **references only**: `env:NAME` or
`file:path`. A literal where a secret belongs is refused when the profile is
read, and errors name the reference, never its value.

```json
{
  "environment": "uat",
  "endpoint": "https://esb-uat.bank.internal/soap/DemoBank",
  "fetch": { "auth": { "scheme": "basic", "user": "svc-wsdl", "password": "env:WSDL_PASSWORD" } },
  "call": {
    "auth": { "scheme": "bearer", "token": "env:SOAP_TOKEN" },
    "tls": {
      "pfx": "file:/secure/client.p12",
      "passphrase": "env:P12_PASS",
      "ca": "file:/secure/ca.pem"
    }
  },
  "wsSecurity": { "user": "env:WS_USER", "password": "env:WS_PASSWORD", "passwordType": "digest" },
  "mutating": { "uat": "deny" }
}
```

- `environment` must be `dev`, `test`, or `uat`; nothing else is accepted.
- `fetch` and `call` are configured separately: `auth` is `none`, `basic`, or
  `bearer`; `tls` is `cert`+`key` (PEM) or `pfx`+`passphrase`, plus an
  optional `ca`.
- `wsSecurity` adds a WS-Security `UsernameToken` (`text` or `digest`) to
  calls.
- Operations confirmed as `mutating` in `operations.md` follow the
  environment's policy: `confirm` (default in dev) asks, `flag` (default in
  test and uat) needs `--allow-mutating <operation>`, `deny` refuses.
  Unclassified operations are never called.

Persisted exchanges drop `wsse:Security` headers and credential-bearing HTTP
headers (`authorization`, cookies, anything named like a token or secret).

## Masking

Every SOAP sample is masked before it is written anywhere or shown to a
model; there is no switch. Personal data is found two ways:

- **by field**: element and attribute names (Italian and English words:
  `iban`, `codiceFiscale`, `partitaIva`, `numeroCarta`, `intestatario`,
  `indirizzo`, `dataNascita`, `codiceOtp`, ...) and the XSD type a field is
  declared with (`IbanType`, `CodiceFiscaleType`);
- **by value**, anywhere in text: IBANs (mod-97), codici fiscali (check
  letter), PANs (Luhn, issuer range), partite IVA after `IT`, emails, and
  `+39` phone numbers.

Replacements are keyed HMAC pseudonyms that keep the format and stay valid:
an Italian IBAN keeps its ABI/CAB and gets a correct CIN and check digits, a
codice fiscale keeps the holder's sex and a valid check letter, a PAN keeps
its BIN and Luhn digit, a partita IVA its office code. One key per service
maps the same input to the same pseudonym everywhere, so relationships
between request and response survive. Free-text fields (`causale`,
`descrizione`) are only scanned for identifiers; a name written inside them
needs a `mask` override in `masking.json` (`{ "fields": { "causale": "mask" } }`),
which also accepts `keep` for a field wrongly caught by a name rule. Every
replacement is reported by path, kind, and reason.

## Layout

```text
soap-ace/
  README.md
  flows/soap-discover.ts        catalog + open questions + proposed operation classes
  flows/soap-sample.ts          request files, calls, SoapUI import, scenario proposals
  flows/soap-design.ts          analysis, 1:1 mapping, design draft and check, OpenAPI projection
  flows/soap-epic.ts            ACE repository seed and the story plan epic-stories runs
  packs/ace12-rest/             gates, judge rubric, prompts, and api-style.md (the REST style guide)
  scaffolds/ace12-rest-api/     README, CONTRIBUTING.md, gate scripts for the ACE repository
  patterns/                     ESQL pattern cards (esito, faults, amounts and enums, paging, nil)
  flows/lib/soap/               the SOAP library (XML, WSDL/XSD, auth, transport, masking, samples)
  fixtures/demo-bank-soap/      synthetic service (WSDL/XSD, responses, SoapUI project, reference design) and the RUNBOOK
  test/
```
