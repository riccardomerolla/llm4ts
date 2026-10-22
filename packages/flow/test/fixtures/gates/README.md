# Gate output fixtures

Recorded test-runner output the gate reason detector (`testGateReasonOf` in
`GateTriage.ts`) is tested against. Absolute paths are shortened to `/wt/a`.

- `vitest-*.txt`: Vitest 4.1.10, `vitest run` (stdout then stderr). `load-failure`
  is two test files importing a module the `effect` package no longer exports;
  `no-test-files` is a project with no test file (exit 1, and the
  `--passWithNoTests` exit 0 variant); `green` is one passing test.
- `surefire-*.txt`: Maven 3.9.12, `mvn -B test` with Surefire 3.5.3 and JUnit
  Jupiter 5.12.2. `no-tests` has no test source at all (BUILD SUCCESS, exit 0);
  `load-failure` is a test class whose static initialiser throws.
- `jest-*.txt` and `pytest-*.txt` are transcribed from the runners' documented
  output shapes (Jest 29, pytest 8), not recorded.
