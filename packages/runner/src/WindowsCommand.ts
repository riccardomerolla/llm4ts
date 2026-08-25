import { existsSync } from "node:fs"
// win32 semantics explicitly, never the host's: this module only ever
// describes Windows, so it should not change meaning with the platform it
// happens to be reasoned about on — and stays testable off Windows.
import { win32 as path } from "node:path"

// Why Windows needs any of this.
//
// `az boards query …` works when a human types it into PowerShell, and the
// same argv fails from `spawn` with `EINVAL`. Both are correct: a shell does
// two things a shell-less spawn does not.
//
//   1. It resolves `az` to a real file using PATHEXT. `spawn` searches PATH
//      but never appends an extension, so a bare `az` is simply not found.
//   2. It knows a `.cmd`/`.bat` is a script, not an image, and hands it to
//      cmd.exe. Windows has no "execute a script" syscall, and since
//      CVE-2024-27980 Node refuses to spawn one directly at all.
//
// So the executor does both itself, rather than turning on a shell. Node's
// own `shell: true` builds its command line as `${file} ${args.join(" ")}`
// with no quoting whatsoever, which splits any argument containing a space
// and hands metacharacters — a WIQL `<>`, say — to cmd.exe as redirection.
// Quoting each argument first is the whole difference.

// Arguments a program must receive whole are quoted the way the Microsoft C
// runtime parses them back: backslashes are literal except before a quote,
// where they double, and a quote inside the value is escaped.
export const quoteArgument = (argument: string): string =>
  argument.length > 0 && !/[\s"&|<>^()%!,;=]/.test(argument)
    ? argument
    : `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`

export const isBatchFile = (file: string): boolean => /\.(?:cmd|bat)$/i.test(file)

export const defaultPathExt = ".COM;.EXE;.BAT;.CMD"

export interface WindowsLookup {
  readonly path?: string | undefined
  readonly pathExt?: string | undefined
  readonly exists?: (candidate: string) => boolean
}

// What a shell does before running anything: find the file the word means.
// A command that already carries an extension is taken at its word; one that
// names a directory is looked for only there.
export const resolveCommand = (command: string, lookup: WindowsLookup = {}): string => {
  if (path.extname(command) !== "") {
    return command
  }
  const exists = lookup.exists ?? existsSync
  const extensions = (lookup.pathExt ?? process.env["PATHEXT"] ?? defaultPathExt)
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
  const directories =
    command.includes(path.sep) || command.includes("/")
      ? [path.dirname(command)]
      : (lookup.path ?? process.env["PATH"] ?? "")
          .split(path.delimiter)
          .filter((directory) => directory.length > 0)
  const name = path.basename(command)
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      if (exists(candidate)) {
        return candidate
      }
    }
  }
  // Unresolved is not an error here: spawning reports "command not found"
  // with the name the caller used, which reads better than a guess.
  return command
}

export interface WindowsInvocation {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly verbatim: boolean
}

// `cmd.exe /d /s /c "<line>"`: /d skips AutoRun, and /s strips exactly the
// outer pair of quotes and runs the rest verbatim. Every argument that
// carries a metacharacter sits inside its own quotes by then, so cmd passes
// it through instead of acting on it. verbatim is what stops libuv quoting
// the line a second time.
export const batchInvocation = (
  argv: ReadonlyArray<string>,
  comspec: string = process.env["ComSpec"] ?? "cmd.exe"
): WindowsInvocation => ({
  file: comspec,
  args: ["/d", "/s", "/c", `"${argv.map(quoteArgument).join(" ")}"`],
  verbatim: true
})

// The one decision this module exists to make. Off Windows, and for a real
// executable on it, nothing changes: the command is spawned directly.
export const windowsInvocation = (
  argv: ReadonlyArray<string>,
  lookup: WindowsLookup = {}
): WindowsInvocation | undefined => {
  const [command, ...rest] = argv
  if (command === undefined) {
    return undefined
  }
  const resolved = resolveCommand(command, lookup)
  return isBatchFile(resolved) ? batchInvocation([resolved, ...rest]) : undefined
}
