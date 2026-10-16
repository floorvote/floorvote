import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** What the preload writes to stderr for each request it refuses. */
export const BLOCKED_MARKER = 'LOOPBACK-ONLY-FETCH: refused'

/**
 * Environment for a spawned node process (and any node it starts, tsx included)
 * that makes `fetch` refuse every host except loopback.
 */
export const loopbackOnlyFetchEnv = (): Record<string, string> => ({
  NODE_OPTIONS: `--import ${path.join(here, 'loopback-only-fetch.preload.mjs')}`,
})
