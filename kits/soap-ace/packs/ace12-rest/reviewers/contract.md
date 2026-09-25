Review the change against contracts/openapi-ace.yaml: an operation, field,
status, or problem code that differs from the contract is a finding; so is a
value built from anything but its x-soap-source, an enum value missing from
its CASE, an amount emitted as a number, a hard-coded endpoint or credential,
or a mapped error without a test.
