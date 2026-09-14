Units are JSP pages, JSP fragments (headers, footers, navigation, included
partials), servlets, DTO/service classes, and web.xml. Judge them as a web
estate, not a batch one:

- A page reached through a web.xml url-pattern, a link, a form action, or a
  redirect is live even when the regex graph shows few callers — check the
  refine notes before calling it dead. A page nothing reaches and nothing
  includes is the retire candidate; give the evidence.
- Fragments with many includers are layout, not business logic: they are
  migrated with the first page that needs them (same wave) rather than as a
  wave of their own, and never "retire" while a live page includes them.
- Servlets and service classes that only front an ESB or backend service are
  "wrap" candidates: the modernized application keeps calling the same
  service through a port, and their business rules must not be re-implemented.
- web.xml and other descriptors are configuration, not migration units:
  disposition "wrap" with a one-line rationale.

Waves are user journeys: keep a page, the servlet it posts to, and the
fragments it includes together; simple read-only screens first, then CRUD
screens, then multi-step session-backed flows last.
