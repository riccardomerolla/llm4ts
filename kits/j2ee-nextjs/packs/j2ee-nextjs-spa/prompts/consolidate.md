In a JSP portal a domain feature is the set of pages one servlet serves and
one ESB service pair backs: a list page with its detail or edit form, the
steps of one wizard (a session draft carried from step to step and a confirm
screen), a read-only screen with its ajax refresh. The shell — header, nav,
footer and any fragment every page includes — is one feature of its own,
planned first because every other feature renders inside it. Filler pages
with no form and no API call (help, profile, messages, settings) may be
folded into one "Portal shell and static pages" feature; say so in the
evidence. Never join two features that talk to different ESB services unless
one page posts to the other's servlet.
