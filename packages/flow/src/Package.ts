import { createRequire } from "node:module"
import * as Schema from "effect/Schema"

const Manifest = Schema.Struct({ version: Schema.String })

const manifest = Schema.decodeUnknownSync(Manifest)(
  createRequire(import.meta.url)("../package.json")
)

export const packageName = "@llm4ts/flow"

/** The published `@llm4ts/flow` version, recorded in provenance manifests. */
export const packageVersion: string = manifest.version
