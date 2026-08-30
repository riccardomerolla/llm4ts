---
match: <c:forEach|<%[^=]*for\s*\(
---
A JSTL/scriptlet row loop becomes the destination DataTable component with
declarative columns: the loop body's cells map to column render functions, and
status-code-to-label mappings move into a typed lookup beside the page. The
data comes from a port call in an effect on mount — never fetched in the
component body, never re-sorted client-side unless the legacy page sorted.
