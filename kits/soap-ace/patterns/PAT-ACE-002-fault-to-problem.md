---
match: Fault|faultcode|ServizioFault|SOAPRequest
---
A SOAP fault arrives on the SOAPRequest node's Failure/Fault terminal, not
Out. Read `faultcode`, `faultstring`, and the detail element's local name,
map them through `x-problem-codes`, and answer with the problem status.
Anything unmapped is `502 backend-error`; never forward faultstring text
verbatim to the client (it can carry internal data).
