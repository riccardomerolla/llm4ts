---
match: paginazione|numeroPagina|page|size|ultimaPagina
---
Page-number pagination maps query `page`/`size` to the SOAP paging fields,
defaulting as the contract's `x-derivation` says, and builds `page` from the
response: `hasNext` from the last-page flag (inverted), `totalItems` only when
the backend sent it. Clamp `size` to the contract maximum before calling.
