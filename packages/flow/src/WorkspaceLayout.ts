const stableHash = (input: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

const normalize = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/, "")

const basename = (path: string): string => {
  const parts = normalize(path).split("/")
  return parts.at(-1) || "repo"
}

export const repoId = (workspace: string, repository: string): string | undefined => {
  const normalizedWorkspace = normalize(workspace)
  const normalizedRepository = normalize(repository)
  return normalizedWorkspace === normalizedRepository
    ? undefined
    : `${basename(normalizedRepository)}-${stableHash(normalizedRepository)}`
}

export const llm4tsDirectory = (workspace: string, repository: string): string => {
  const root = `${normalize(workspace)}/.llm4ts`
  const id = repoId(workspace, repository)
  return id === undefined ? root : `${root}/${id}`
}
