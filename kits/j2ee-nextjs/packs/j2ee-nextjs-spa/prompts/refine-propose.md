The target is an existing Next.js SPA with a design system, an AuthProvider, a
router, and a port/adapter service convention. Things such a target usually
PROVIDES, so a legacy page or scenario about them is a `provided` candidate
once you have found the file that proves it:

- login, logout, session timeout, and "remember me" — the AuthProvider and its
  login route own these; a legacy login JSP is provided, not converted;
- navigation shell, header, footer, and the nav link set — the app layout;
- "back" links, breadcrumbs, and page titles — the router and layout;
- session-carried drafts between wizard steps — client state, not a session;
- client-side validation libraries — the house Form validation map.

Things commonly DEPRECATED in a JSP estate, `drop` candidates when the spec
itself shows the evidence (dead route, expired campaign, developer harness,
print-only view, applet or Flash embed, frameset): name the evidence, never
guess from the page name alone. Never propose `defer`.
