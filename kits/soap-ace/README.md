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
`LLM4TS_SOAP_SERVICE` overrides the service directory name. WSDL URLs arrive
with the auth-aware transport; until then pass a local path.

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
  api-style.md                  default REST style guide (a project-tier copy overrides it)
  flows/soap-discover.ts        catalog + open questions + proposed operation classes
  flows/lib/soap/               the SOAP library: Xml, Catalog, Xsd, Wsdl, Classification, Discover
  fixtures/demo-bank-soap/      synthetic service: conti, movimenti, bonifici
  test/
```
