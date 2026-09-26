---
match: esito|codice|KO\d\d|problem
---
A SOAP response can fail inside HTTP 200: `esito.codice` other than the OK
code is a business error. Test it before mapping the payload; look the code up
in the operation's `x-problem-codes` and route to the error subflow with the
HTTP status, problem `code`, and `title` from the contract. Trap: mapping the
payload first and checking esito afterwards returns half-filled 200s.
