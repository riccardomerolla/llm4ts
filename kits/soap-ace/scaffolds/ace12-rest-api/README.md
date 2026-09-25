# __API__

The IBM App Connect Enterprise 12 REST API in front of the `__SERVICE__` SOAP
service, seeded by `soap-epic` from the approved design and implemented story
by story by `epic-stories`.

| Path                   | What it holds                                                          | Edited by                  |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------- |
| `contracts/`           | the approved design, the OpenAPI contract, the 1:1 mapping, the WSDL   | nobody (regenerated)       |
| `__API__/`             | the REST API project: descriptors, main flow, one broker schema per resource | stories                    |
| `__API__Lib/`          | shared library: the imported WSDL, SOAP call and error-mapping subflows | the `shared-lib` story     |
| `__API__Policies/`     | policy project: backend endpoints and security per environment          | the `policies` story       |
| `__API___Test/`        | ACE unit tests (JUnit) with the recorded backend stubs                  | stories                    |
| `test-data/`           | masked SOAP exchanges recorded by `soap-sample`, the stubs' source      | nobody (regenerated)       |
| `docs/`                | analysis reports and ESQL pattern cards                                 | nobody (regenerated)       |
| `scripts/ace-gates.sh` | the gates `epic-stories` runs: `build` and `test`                       | the team                   |
