/**
 * Builds the `llm4ts watch --web` page (ADR 0051) into packages/shell/web:
 * bundles packages/shell/web-src/main.ts to app.js for the browser, and
 * copies the Geist fonts and their licence from the `geist` package into
 * fonts/. Both outputs are generated, git-ignored and shipped in the shell
 * tarball. Run as part of `pnpm build`.
 *
 * The bundle must not reach Node: a `node:` builtin or a platform-node
 * package fails the build instead of shipping a page that cannot load.
 */
import { copyFileSync, mkdirSync, statSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const shell = path.join(repoRoot, "packages", "shell")
const webDir = path.join(shell, "web")

const nodeOnly = {
  name: "no-node",
  setup(builder) {
    builder.onResolve({ filter: /^(node:|@effect\/platform-node)/ }, (args) => ({
      errors: [{ text: `${args.path} is Node-only; the page runs in a browser` }]
    }))
  }
}

const result = await build({
  entryPoints: [path.join(shell, "web-src", "main.ts")],
  outfile: path.join(webDir, "app.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "none",
  tsconfig: path.join(shell, "tsconfig.web.json"),
  plugins: [nodeOnly],
  logLevel: "warning",
  metafile: true
})

const fonts = path.join(webDir, "fonts")
mkdirSync(fonts, { recursive: true })
// A root devDependency; its exports map hides the font files from require.resolve.
const geist = path.join(repoRoot, "node_modules", "geist")
const copies = [
  ["dist/fonts/geist-sans/Geist-Variable.woff2", "Geist-Variable.woff2"],
  ["dist/fonts/geist-mono/GeistMono-Variable.woff2", "GeistMono-Variable.woff2"],
  ["LICENSE.txt", "OFL.txt"]
]
for (const [from, to] of copies) {
  copyFileSync(path.join(geist, from), path.join(fonts, to))
}

const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0)
const fontBytes = copies.reduce((sum, [, to]) => sum + statSync(path.join(fonts, to)).size, 0)
console.log(
  `watch --web page: app.js ${(bytes / 1024).toFixed(1)} KiB, fonts ${(fontBytes / 1024).toFixed(1)} KiB`
)
