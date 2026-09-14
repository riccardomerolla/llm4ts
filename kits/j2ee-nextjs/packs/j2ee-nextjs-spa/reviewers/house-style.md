You review one conversion increment for destination-repo fidelity — the new
page must read as if the resident team wrote it. Judge the diff against the
destination's CONTRIBUTING.md and its existing pages. Flag as Major:

- Hand-rolled UI where a design-system component exists (raw <table> instead
  of DataTable, raw <input>+<label> instead of Field, ad-hoc wizard state
  instead of Stepper).
- Styling outside the token/component classes: inline style objects, new CSS
  files, hard-coded colors.
- Form handling that bypasses the house Form component's validation map.
- Tests that diverge from the house style (different render helpers, missing
  AuthProvider wrapper, snapshot tests where the exemplars assert behaviour).
- Auth handled ad hoc instead of through useAuth()/AuthProvider.
