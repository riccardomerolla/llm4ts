import { createClient } from "@llm4ts/js"

const client = createClient({ provider: "mock", model: "mock" })
const response = await client.complete(globalThis.process.argv.slice(2).join(" ") || "Hello")
globalThis.process.stdout.write(`${response.content}\n`)
