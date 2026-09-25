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

## Layout

```text
soap-ace/
  README.md
  api-style.md                  default REST style guide (a project-tier copy overrides it)
  flows/lib/soap/               the SOAP library: Xml, Catalog, Xsd, Wsdl, ...
  fixtures/demo-bank-soap/      synthetic service: conti, movimenti, bonifici
  test/
```
