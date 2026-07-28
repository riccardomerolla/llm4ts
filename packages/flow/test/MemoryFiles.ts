import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"

export const memoryFiles = (
  files: Ref.Ref<Readonly<Record<string, string>>>
): PlainFileStoreShape => ({
  read: (path) => Ref.get(files).pipe(Effect.map((current) => current[path])),
  writeAtomic: (path, contents) =>
    Ref.update(files, (current) => ({ ...current, [path]: contents })),
  append: (path, contents) =>
    Ref.update(files, (current) => ({
      ...current,
      [path]: `${current[path] ?? ""}${contents}`
    })),
  remove: (path) =>
    Ref.update(files, (current) =>
      Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== path))
    ),
  hashSha256: (_path) => Effect.succeed("digest")
})
