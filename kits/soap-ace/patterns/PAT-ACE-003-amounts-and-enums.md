---
match: importo|saldo|valore|divisa|amount|enumMap|x-soap-enum-map
---
Amounts leave as `{ "amount": "<decimal string>", "currency": "EUR" }`:
`CAST(value AS CHARACTER)` keeps the digits the backend sent. Enumerations go
through a CASE built from `x-soap-enum-map`, one WHEN per SOAP value, and an
ELSE that raises the mapping error. Trap: values seen in the samples but
missing from the WSDL (the analysis lists them) must be in the CASE too.
