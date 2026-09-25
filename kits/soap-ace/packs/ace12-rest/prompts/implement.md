Implement the story in the ACE 12 projects of this repository, following
CONTRIBUTING.md and the pattern cards in docs/patterns/. The contract in
contracts/ is fixed: implement it, never change it. Build every request and
response field from the x-soap-source the contract names and the WSDL in the
shared library; route every business error and fault through the error
subflow with the status and code x-problem-codes gives. Add ACE unit tests
against the recorded stubs for the happy path, every mapped error, and every
enum value.
