// The trust list: which project config files this user has accepted. A
// project file can set commands llm4ts runs, so it is used only when the
// user trusted exactly that content for exactly that repository. The list
// lives outside every repository; nothing a repository holds can add to it.
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import type { Environment } from "@llm4ts/flow/Settings"

/** A repository's absolute path to the SHA-256 of its trusted project file. */
export type TrustRecords = Readonly<Record<string, string>>

const TrustRecordsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

export type TrustStore =
  | { readonly _tag: "Loaded"; readonly records: TrustRecords }
  | { readonly _tag: "Unusable"; readonly reason: string }

/** How a project file stands against the list; `absent`: there is no file. */
export type ProjectTrust = "absent" | "trusted" | "untrusted" | "changed"

/** A project file that exists and is not used. */
export type Distrust = "untrusted" | "changed"

/** `${XDG_STATE_HOME:-~/.local/state}/llm4ts/config-trust.json`. */
export const configTrustPath = (environment: Environment): string =>
  join(
    environment.XDG_STATE_HOME ?? join(environment.HOME ?? homedir(), ".local", "state"),
    "llm4ts",
    "config-trust.json"
  )

/** The SHA-256 of the text llm4ts parses, in hex. */
export const contentHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex")

/** Pure: the list as stored; an absent file is an empty list. */
export const readTrustStore = (text: string | undefined): TrustStore => {
  if (text === undefined) {
    return { _tag: "Loaded", records: {} }
  }
  const decoded = Schema.decodeUnknownResult(TrustRecordsJson)(text)
  return Result.isSuccess(decoded)
    ? { _tag: "Loaded", records: decoded.success }
    : { _tag: "Unusable", reason: "not a JSON object of repository paths and hashes" }
}

/**
 * Pure: trusted only when the list holds this hash for this repository's
 * absolute path. A list that cannot be used trusts nothing.
 */
export const trustDecision = (
  store: TrustStore,
  repo: string,
  hash: string
): Distrust | "trusted" => {
  if (store._tag === "Unusable") {
    return "untrusted"
  }
  const key = resolve(repo)
  const recorded = Object.hasOwn(store.records, key) ? store.records[key] : undefined
  return recorded === undefined ? "untrusted" : recorded === hash ? "trusted" : "changed"
}

/** Never fails: a list that cannot be read is `Unusable`. */
export const loadTrustStore = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<TrustStore> =>
  files.read(path).pipe(
    Effect.map(readTrustStore),
    Effect.catch((error) => Effect.succeed<TrustStore>({ _tag: "Unusable", reason: error.message }))
  )

const save = (files: PlainFileStoreShape, path: string, records: TrustRecords) =>
  files.writeAtomic(
    path,
    `${JSON.stringify(
      Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b))),
      undefined,
      2
    )}\n`
  )

/** Records `hash` for `repo`, keeping every other repository's record; an unusable list is replaced. */
export const recordTrust = Effect.fn("@llm4ts/shell/ConfigTrust.record")(function* (
  files: PlainFileStoreShape,
  path: string,
  repo: string,
  hash: string
): Effect.fn.Return<void, PersistenceError> {
  const store = yield* loadTrustStore(files, path)
  yield* save(files, path, {
    ...(store._tag === "Loaded" ? store.records : {}),
    [resolve(repo)]: hash
  })
})

/** Removes the record of `repo`; succeeds with whether there was one. */
export const forgetTrust = Effect.fn("@llm4ts/shell/ConfigTrust.forget")(function* (
  files: PlainFileStoreShape,
  path: string,
  repo: string
): Effect.fn.Return<boolean, PersistenceError> {
  const store = yield* loadTrustStore(files, path)
  const key = resolve(repo)
  if (store._tag === "Unusable" || !Object.hasOwn(store.records, key)) {
    return false
  }
  yield* save(
    files,
    path,
    Object.fromEntries(Object.entries(store.records).filter(([held]) => held !== key))
  )
  return true
})

/** The one command that reviews and accepts the project file of `repo`. */
export const trustCommand = (repo: string): string => `llm4ts config trust --repo ${resolve(repo)}`

const standing = (projectPath: string, trust: Distrust): string =>
  trust === "changed"
    ? `${projectPath} has changed since it was trusted`
    : `${projectPath} is new and not trusted`

/** What every verb that goes on without the file says. */
export const distrustNotice = (projectPath: string, repo: string, trust: Distrust): string =>
  `${standing(projectPath, trust)}, so llm4ts did not read it. Review and accept it: ${trustCommand(repo)}`

/** Why a launch stops: a run must not go on other settings than the file says. */
export const launchRefusal = (projectPath: string, repo: string, trust: Distrust): string =>
  `${distrustNotice(projectPath, repo, trust)}\nNothing was started.`

/** Why `config set`, `unset`, `init` and `edit` leave the file alone. */
export const writeRefusal = (projectPath: string, repo: string, trust: Distrust): string =>
  `${standing(projectPath, trust)}, so llm4ts writes nothing to it. Review and accept it first: ${trustCommand(repo)}`

/** Said once per load when the list itself cannot be used. */
export const unusableStoreNotice = (storePath: string, reason: string): string =>
  `${storePath}: the trust list cannot be used (${reason}), so no project file is trusted; llm4ts config trust writes a new list`
