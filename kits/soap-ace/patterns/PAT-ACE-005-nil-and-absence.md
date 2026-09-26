---
match: nil|nillable|nullable|optional
---
Absent SOAP elements are omitted from the JSON; `xsi:nil="true"` becomes
`null` only for properties the contract marks `nullable`, otherwise the
property is omitted. Never emit empty strings for absent values: an empty
string is data. Test both an absent and a nil element per nullable property.
