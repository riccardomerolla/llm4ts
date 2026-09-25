# Contributing to __API__

House rules for every change, human or agent. The contract comes first: the
code implements `contracts/`, never the other way round.

## The contract

- `contracts/openapi-ace.yaml` (OpenAPI 3.0.3, what ACE 12 imports) and
  `contracts/openapi.yaml` (3.1) are projected from `contracts/api-design.json`.
  Never edit them; a contract change is a design change upstream.
- Every property and parameter carries `x-soap-source`: the XSD path it maps
  from or to. Every enumeration carries `x-soap-enum-map`: SOAP value → REST
  value. Implement exactly these mappings; `contracts/mapping.json` lists
  every SOAP field.
- Errors are RFC 9457 problem details. `x-problem-codes` names, per HTTP
  status, the problem `code` and the SOAP outcome codes and fault elements it
  maps from. Anything unmapped is `502 backend-error`.

## Project layout

- `__API__/` is the REST API project. Each resource has its own broker
  schema folder (`accounts/`, `creditTransfers/`) holding one subflow per
  operation (named after its `operationId`) and its ESQL modules.
- `__API__Lib/` holds the imported WSDL and XSDs, the subflow that calls the
  backend (`SOAPRequest` node, WS-Security and endpoints from policies), and
  the error-mapping subflow every operation uses.
- `__API__Policies/` holds one HTTP/SOAP policy set per environment (`dev`,
  `test`, `uat`); no endpoint, credential, or certificate path is ever
  hard-coded in a flow or ESQL module.

## ESQL

- One `CREATE COMPUTE MODULE` per mapping step, named
  `<operationId>_<Step>` (`listAccounts_BuildRequest`, `listAccounts_MapResponse`).
- Build SOAP requests and REST responses field by field from the mapping;
  never copy trees wholesale (`SET OutputRoot.JSON.Data = InputRoot...`),
  which would leak SOAP names and the esito envelope.
- Amounts are decimal strings: `CAST(x AS CHARACTER)` of the XSD decimal,
  never a JSON number. Dates stay ISO 8601 as received.
- Enumerations go through a `CASE` over `x-soap-enum-map`; an unmapped value
  is an error routed to the error subflow, never passed through.
- Absent optional values are omitted; `xsi:nil` becomes JSON `null` only
  where the contract says `nullable`.
- See `docs/patterns/` for the recurring cases.

## Tests and gates

- Every operation has ACE unit tests in `__API___Test/src/<resource>/` that
  run the flow against the recorded backend stubs in `__API___Test/stubs/`
  (built from `test-data/`): the happy path, every mapped business error,
  and every enum value the contract lists.
- `scripts/ace-gates.sh build` packages the BAR with `ibmint`;
  `scripts/ace-gates.sh test` deploys to a scratch work directory and runs the
  test project. Both must pass before a story is merged.
