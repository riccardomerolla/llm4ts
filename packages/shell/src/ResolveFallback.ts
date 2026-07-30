/**
 * Module-resolution fallback registered in flow child processes via
 * `--import`. Resolution is tried normally first, so a project-local
 * `node_modules` with its own `@llm4ts/*` pin always wins; only when a bare
 * specifier fails to resolve from the flow's own location is it retried
 * anchored at this file — the shell's installation, whose dependencies
 * include `@llm4ts/*` and `effect`. See ADR 0006.
 */
import { registerHooks } from "node:module"

const anchor = import.meta.url

const isBareSpecifier = (specifier: string): boolean =>
  !specifier.startsWith(".") &&
  !specifier.startsWith("/") &&
  !specifier.startsWith("file:") &&
  !specifier.startsWith("node:") &&
  !specifier.startsWith("data:")

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (isBareSpecifier(specifier) && context.parentURL !== anchor) {
        return nextResolve(specifier, { ...context, parentURL: anchor })
      }
      throw error
    }
  }
})
