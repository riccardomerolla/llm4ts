import { createHash } from "node:crypto"

export const reviewFingerprint = (...parts: ReadonlyArray<string>): string => {
  const digest = createHash("sha256")
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8")
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    digest.update(length)
    digest.update(bytes)
  }
  return digest.digest("hex")
}
