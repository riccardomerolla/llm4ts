#!/usr/bin/env node
// A stand-in `gws` for `llm4ts chat`: one in-memory space kept in <sandbox>/gws/.
//   gws --version                               → gws 0.22.5
//   gws chat spaces messages list --params …    → the space's messages after the filter's createTime
//   gws chat spaces messages create --params … --json …  → posts as users/OWNER, logs to posted.log
//   gws say <users/…> <text>                    → someone types a message into the space (test helper)
const fs = require("node:fs")
const path = require("node:path")

const dir = path.join(__dirname, "..", "gws")
const store = path.join(dir, "messages.jsonl")
fs.mkdirSync(dir, { recursive: true })
const all = () =>
  fs.existsSync(store)
    ? fs
        .readFileSync(store, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const add = (sender, text, thread) => {
  const id = `M${all().length + 1}`
  const message = {
    name: `spaces/TEST/messages/${id}`,
    sender: { name: sender, type: "HUMAN" },
    createTime: new Date().toISOString(),
    text,
    thread: { name: thread ?? `spaces/TEST/threads/${id}` },
    space: { name: "spaces/TEST" }
  }
  fs.appendFileSync(store, JSON.stringify(message) + "\n")
  return message
}
const flag = (name) => {
  const at = process.argv.indexOf(name)
  return at < 0 ? {} : JSON.parse(process.argv[at + 1])
}

const [first, ...rest] = process.argv.slice(2)
if (first === "--version") {
  console.log("gws 0.22.5")
} else if (first === "say") {
  console.log(JSON.stringify(add(rest[0], rest.slice(1).join(" "))))
} else if (rest.join(" ").startsWith("spaces messages list")) {
  const after = /createTime > "([^"]+)"/.exec(flag("--params").filter ?? "")?.[1]
  const since = after === undefined ? -Infinity : Date.parse(after)
  console.log(JSON.stringify({ messages: all().filter((m) => Date.parse(m.createTime) > since) }))
} else if (rest.join(" ").startsWith("spaces messages create")) {
  const body = flag("--json")
  const message = add("users/OWNER", body.text, body.thread?.name)
  fs.appendFileSync(path.join(dir, "posted.log"), `${message.thread.name} ${body.text}\n`)
  console.log(JSON.stringify(message))
} else {
  console.log(JSON.stringify({ error: { code: 400, reason: "badRequest", message: "stub gws" } }))
  process.exit(1)
}
