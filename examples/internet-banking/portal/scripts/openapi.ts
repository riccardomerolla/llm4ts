// Renders every domain contract under src/contracts/*.ts into
// contracts/openapi/<domain>.json. Domains are discovered, not listed, so a
// new domain needs no edit here. Run with `pnpm openapi` (Node 22+ strips
// types natively).
import { readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const contracts = join(root, "src", "contracts")
const out = join(root, "contracts", "openapi")
mkdirSync(out, { recursive: true })

const files = readdirSync(contracts)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".fake.ts") && !name.endsWith(".test.ts"))
  .sort()

for (const file of files) {
  const module: Record<string, unknown> = await import(pathToFileURL(join(contracts, file)).href)
  const apis = Object.values(module).filter((value) => HttpApi.isHttpApi(value))
  for (const api of apis) {
    const spec = OpenApi.fromApi(api)
    const target = join(out, `${file.replace(/\.ts$/, "")}.json`)
    writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`)
    process.stdout.write(`${target}\n`)
  }
}
