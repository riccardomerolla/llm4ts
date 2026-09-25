# Pack: ace12-rest

source: soap
scaffold: ../../scaffolds/ace12-rest-api
sources: .*\.(wsdl|xsd)
specs-dir: contracts
features-dir: ACE_Test/src

## Gates

- build: bash scripts/ace-gates.sh build
- test: bash scripts/ace-gates.sh test

## Judge

- contract (0..2): Every operation, parameter, property, status, and problem code of the OpenAPI contract is implemented exactly; nothing is added. Score 2 only if the implementation matches the contract completely.
- mapping (0..2): Every value is built from the x-soap-source the contract names, amounts stay decimal strings, and every x-soap-enum-map entry, including values seen only in the samples, is handled. Score 2 only if no mapping is guessed.
- errors (0..2): Every esito code and SOAP fault listed in x-problem-codes becomes its problem response, and nothing unmapped leaks backend text. Score 2 only if every error path is implemented and tested.
