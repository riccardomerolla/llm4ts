---
match: <jsp:include|<%@\s*include
---
header/nav/footer jsp:include shells are ALREADY provided by the destination
app shell (layout + PageLayout) — a converted page never re-renders chrome.
Map the legacy page body into PageLayout's slots, and turn nav.jsp links into
the routes of pages that exist (converted or exemplar); links to not-yet-
converted pages stay out of nav rather than dangling.
