The spec markdown for a page has two mandatory parts:

1. Prose sections: Screen (layout, displayed data, status label mappings),
   Forms (each field: name, label, type, required; each validation rule with
   its VERBATIM message and where it is enforced — client, server, or both),
   Navigation (inbound links, outbound links/redirects, step order for
   multi-step flows), API (each endpoint: method, path, request/response
   fields, and the ESB service it wraps), Session state, Anti-corruption
   renames (every legacy DTO field → proposed domain name), Open questions.

2. EXACTLY ONE fenced block starting with ```json pagespec containing a JSON
   object with this shape (all names in domain language where marked):

   {
     "page": "<program name, e.g. accountOverview>",
     "route": "<legacy url-pattern>",
     "title": "<screen title>",
     "complexity": "low" | "medium" | "high",
     "forms": [{ "name", "action", "fields": [{ "name", "label", "type",
       "required", "validations": [{ "rule", "message", "enforcedAt":
       "client"|"server"|"both" }] }] }],
     "dtos": [{ "legacyName", "domainName", "fields": [{ "legacyName",
       "domainName", "type" }] }],
     "apiCalls": [{ "operation": "<domain verb, e.g. listAccounts>",
       "method", "path", "esbService", "request": [{ "legacyName",
       "domainName", "type" }], "response": [{ ... }] }],
     "navigation": { "inbound": [], "outbound": [], "steps": [] },
     "sessionState": ["<what the session carries and why>"],
     "openQuestions": []
   }

The block is machine-validated downstream: malformed JSON or a missing block
fails the page. The JSON and the prose must agree — the JSON is the contract,
the prose is the evidence.
