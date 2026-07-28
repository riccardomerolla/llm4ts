# Examples

`basic.ts` exercises the public runner with the deterministic mock connector, so
it needs no provider credentials or installed coding CLI.

```sh
node --experimental-strip-types examples/basic.ts "Explain this repository"
```

For embedded applications, return the `Effect` from `runNode` to the
application's existing Effect runtime instead of calling `Effect.runFork`.
