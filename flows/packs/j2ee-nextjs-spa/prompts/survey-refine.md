This is a J2EE web application: units are JSP pages and fragments, servlets and
supporting Java classes, and deployment descriptors. Regexes miss most of the
links such an application establishes indirectly:

- WEB-INF/web.xml: every servlet-mapping ties a url-pattern to a servlet; every
  servlet-class names a Java unit; welcome-file and error-page entries name
  JSPs. A JSP form action, link, or redirect that targets a url-pattern is an
  edge from the JSP to the servlet behind it.
- Servlets: request.getRequestDispatcher(...).forward/include and
  response.sendRedirect(...) name the JSP or url-pattern they hand off to;
  new/injected service and DAO classes are outgoing edges to those units.
- JSPs: static includes (<%@ include file="…" %>), dynamic includes
  (<jsp:include page="…">), <jsp:forward>, <a href="…">, <form action="…">,
  jQuery $.ajax / $.get / $.post url targets, and JSTL <c:import>/<c:url>.
  Resolve a path to the unit whose file name (without extension) matches.
- Tag libraries and shared layout fragments (header, footer, navigation) are
  units only when they are files in the inventory.

Prioritise JSPs with zero incoming edges (are they reached through web.xml or
a redirect?), servlets nothing maps to, and fragments nothing includes. Calls to
the ESB, application-server services, and third-party libraries are not estate
edges — note them.
