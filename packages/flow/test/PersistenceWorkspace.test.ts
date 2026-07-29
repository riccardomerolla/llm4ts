import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import {
  loadVersioned,
  makeMemoryPlainFileStore,
  makePlanStore,
  saveVersioned
} from "@llm4ts/flow/Persistence"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { Provenance, makeProvenanceStore } from "@llm4ts/flow/Provenance"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { workspaceTools } from "@llm4ts/flow/WorkspaceTools"

describe("atomic plain-file and versioned persistence", () => {
  it.effect("saves, loads, resumes, and removes canonical Markdown plans", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const path = "nested/plan.md"
      const store = makePlanStore(memory.store)
      const plan = Plan.make({
        epicId: "epic",
        tasks: [Task.make({ title: "a", description: "do a" })]
      })
      const created = yield* Ref.make(0)
      const first = yield* store.recoverOrCreate(
        path,
        Ref.update(created, (count) => count + 1).pipe(Effect.as(plan))
      )
      const second = yield* store.recoverOrCreate(
        path,
        Ref.update(created, (count) => count + 1).pipe(
          Effect.as(Plan.make({ epicId: "other", tasks: [] }))
        )
      )

      assert.deepStrictEqual(first, plan)
      assert.deepStrictEqual(second, plan)
      assert.strictEqual(yield* Ref.get(created), 1)
      yield* store.remove(path)
      assert.strictEqual(yield* store.load(path), undefined)
    })
  )

  it.effect("round-trips a versioned document and rejects an unknown version", () =>
    Effect.gen(function* () {
      class Document extends Schema.Class<Document>("Document")({
        value: Schema.String
      }) {}
      const memory = yield* makeMemoryPlainFileStore()
      const path = "document.json"
      yield* saveVersioned(memory.store, path, 1, Document, Document.make({ value: "ok" }))
      const loaded = yield* loadVersioned(memory.store, path, 1, Document)
      const error = yield* Effect.flip(loadVersioned(memory.store, path, 2, Document))

      assert.strictEqual(loaded?.value, "ok")
      assert.strictEqual(error._tag, "UnsupportedSchemaVersion")
    })
  )

  it.effect("persists, extends, and externally hashes provenance artifacts", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic("work/spec.md", "hello\n")
      const store = makeProvenanceStore(memory.store)
      const path = "work/provenance.json"
      const manifest = Provenance.make({
        schema: 1,
        pack: "sample",
        llm4tsVersion: "0.0.0",
        createdAt: "2026-07-28T00:00:00Z",
        approvedBy: "owner",
        seats: { analyst: "model-a" },
        specs: {},
        gateVerdicts: {},
        fixSpecs: []
      })
      yield* store.write(path, manifest)
      const extended = yield* store.extend(
        path,
        (current) =>
          new Provenance({
            ...current,
            equivalenceReport: "digest"
          })
      )
      const hashes = yield* store.hashFiles("work", ["spec.md"])

      assert.strictEqual(extended.equivalenceReport, "digest")
      assert.strictEqual(
        hashes["spec.md"],
        "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
      )
    })
  )
})

describe("in-memory bounded workspace", () => {
  it.effect("reads, writes, appends, discovers, and searches inside the root", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write("src/a.ts", "first\nneedle\n")
      yield* workspace.append("src/a.ts", "last\n")

      assert.strictEqual(yield* workspace.read("src/a.ts"), "first\nneedle\nlast\n")
      assert.deepStrictEqual(yield* workspace.discover("**/*.ts"), ["src/a.ts"])
      const matches = yield* workspace.search("needle", "**/*.ts")
      assert.strictEqual(matches[0]?.path, "src/a.ts")
      assert.strictEqual(matches[0]?.line, 2)
    })
  )

  it.effect("rejects traversal, oversize content, and result overflow", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace({
        limits: { maxReadBytes: 3, maxWriteBytes: 3, maxResults: 1, maxDepth: 4 },
        initial: { "many/a": "x", "many/b": "x" }
      })

      const traversal = yield* Effect.flip(workspace.resolve("../outside"))
      const oversize = yield* Effect.flip(workspace.write("large", "1234"))
      const overflow = yield* Effect.flip(workspace.discover("**/*"))

      assert.strictEqual(traversal._tag, "WorkspacePath")
      assert.strictEqual(oversize._tag, "WorkspaceLimit")
      assert.strictEqual(overflow._tag, "WorkspaceLimit")
    })
  )

  it.effect("exposes bounded workspace operations as catalog-ready tools", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      const tools = workspaceTools(workspace)
      const write = tools.find((tool) => tool.name === "workspace_write")
      const read = tools.find((tool) => tool.name === "workspace_read")
      const validate = tools.find((tool) => tool.name === "workspace_validate_json")

      assert.isDefined(write)
      assert.isDefined(read)
      assert.isDefined(validate)
      if (write !== undefined && read !== undefined && validate !== undefined) {
        yield* write.execute({
          path: "data.json",
          contents: '{"ok":true}'
        })
        assert.strictEqual(yield* read.execute({ path: "data.json" }), '{"ok":true}')
        assert.deepStrictEqual(yield* validate.execute({ path: "data.json" }), { valid: true })
      }
      assert.deepStrictEqual(
        tools.map((tool) => tool.name),
        [
          "workspace_read",
          "workspace_write",
          "workspace_append",
          "workspace_discover",
          "workspace_search",
          "workspace_validate_json"
        ]
      )
    })
  )
})
