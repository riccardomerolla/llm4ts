import { assert, describe, it } from "@effect/vitest"
import {
  batchInvocation,
  defaultPathExt,
  isBatchFile,
  quoteArgument,
  resolveCommand,
  windowsInvocation
} from "@llm4ts/runner/WindowsCommand"

// A Windows PATH with the Azure CLI installed the way its MSI installs it.
const lookup = {
  path: "C:\\Windows\\System32;C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin",
  pathExt: defaultPathExt,
  // Windows filenames are case-insensitive, and PATHEXT is upper case, so
  // `az` resolves through `az.COM`, `az.EXE`, `az.BAT` to `az.CMD`.
  exists: (candidate: string): boolean =>
    [
      "c:\\program files\\microsoft sdks\\azure\\cli2\\wbin\\az.cmd",
      "c:\\windows\\system32\\where.exe"
    ].includes(candidate.toLowerCase())
}

describe("Windows argument quoting", () => {
  it("leaves ordinary arguments alone", () => {
    assert.strictEqual(quoteArgument("boards"), "boards")
    assert.strictEqual(quoteArgument("--output"), "--output")
    assert.strictEqual(quoteArgument("https://dev.azure.com/acme"), "https://dev.azure.com/acme")
  })

  it("quotes a WIQL query so cmd.exe cannot read <> as redirection", () => {
    // This is the bug in Node's own `shell: true`, which joins argv with a
    // bare space: cmd would split the query on whitespace and treat `<>` as
    // "read from, write to", which is exactly what PowerShell reports when
    // the same text is pasted at a prompt.
    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Closed'"
    const quoted = quoteArgument(wiql)

    assert.strictEqual(quoted, `"${wiql}"`)
    assert.isTrue(quoted.startsWith('"') && quoted.endsWith('"'))
  })

  it("survives quotes, trailing backslashes, and emptiness", () => {
    // Backslashes are literal except before a quote, where they double.
    assert.strictEqual(quoteArgument('say "hi"'), '"say \\"hi\\""')
    assert.strictEqual(quoteArgument("C:\\path with space\\"), '"C:\\path with space\\\\"')
    assert.strictEqual(quoteArgument(""), '""')
    assert.strictEqual(quoteArgument("a&b"), '"a&b"')
    assert.strictEqual(quoteArgument("50%"), '"50%"')
  })
})

describe("Windows command resolution", () => {
  it("finds the file a bare name means, the way a shell would", () => {
    // `spawn` searches PATH but never appends a PATHEXT extension, so `az`
    // resolves to nothing while the same word works in PowerShell.
    assert.strictEqual(
      resolveCommand("az", lookup),
      "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.CMD"
    )
  })

  it("takes a command with an extension at its word", () => {
    assert.strictEqual(resolveCommand("node.exe", lookup), "node.exe")
    assert.strictEqual(resolveCommand("C:\\tools\\thing.cmd", lookup), "C:\\tools\\thing.cmd")
  })

  it("returns the name unchanged when nothing matches", () => {
    // Better a "command not found" naming what the caller asked for than a
    // guess at some path they never mentioned.
    assert.strictEqual(resolveCommand("nope", lookup), "nope")
  })

  it("knows a script from an image", () => {
    assert.isTrue(isBatchFile("az.cmd"))
    assert.isTrue(isBatchFile("C:\\x\\GEMINI.BAT"))
    assert.isFalse(isBatchFile("git.exe"))
    assert.isFalse(isBatchFile("az"))
  })
})

describe("Windows invocation", () => {
  it("hands a batch file to cmd.exe with every argument quoted", () => {
    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Closed'"
    const invocation = windowsInvocation(
      ["az", "boards", "query", "--wiql", wiql, "--detect", "false"],
      lookup
    )

    assert.isDefined(invocation)
    assert.strictEqual(invocation?.args[0], "/d")
    assert.strictEqual(invocation?.args[1], "/s")
    assert.strictEqual(invocation?.args[2], "/c")
    // libuv must not quote the line a second time.
    assert.isTrue(invocation?.verbatim)

    const line = invocation?.args[3] ?? ""
    // /s strips exactly the outer pair and runs the rest verbatim.
    assert.isTrue(line.startsWith('"') && line.endsWith('"'))
    // The resolved batch file, and the query, each inside their own quotes.
    assert.include(line, '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.CMD"')
    assert.include(line, `"${wiql}"`)
    // The property that matters: after /s removes the outer pair, every
    // metacharacter left in the line sits inside a quoted run, so cmd
    // passes it to `az` instead of opening a file.
    const afterOuterQuotes = line.slice(1, -1)
    const outsideQuotes = afterOuterQuotes.replace(/"[^"]*"/g, "")
    assert.notInclude(outsideQuotes, "<")
    assert.notInclude(outsideQuotes, ">")
    assert.strictEqual(outsideQuotes.trim(), "boards query --wiql  --detect false")
  })

  it("leaves a real executable to spawn directly", () => {
    // Nothing changes for git, node, or an .exe-shipped CLI: no cmd.exe in
    // the way, no quoting layer, no behaviour to regress.
    assert.isUndefined(windowsInvocation(["where.exe", "az"], lookup))
    assert.isUndefined(windowsInvocation(["git", "status"], lookup))
    assert.isUndefined(windowsInvocation([], lookup))
  })

  it("builds the cmd line from an explicit comspec", () => {
    const invocation = batchInvocation(["thing.cmd", "a b"], "C:\\Windows\\System32\\cmd.exe")

    assert.strictEqual(invocation.file, "C:\\Windows\\System32\\cmd.exe")
    assert.strictEqual(invocation.args[3], '"thing.cmd "a b""')
  })
})
