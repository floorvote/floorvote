/**
 * Bill handles: how an instance refers to a central bill. A tenant bill's
 * `external_id` holds the handle, `legiscan:<n>`, where `<n>` is central's
 * bill row id. The prefix is legacy and means "central bill," not where the
 * data came from (see **Bill handle** in CONTEXT.md).
 *
 * Every place in the instance API and web app that builds or parses a handle
 * goes through here, so the format lives in one place. Central has its own
 * copy in `central/src/lib/billHandle.ts` (central is a standalone package).
 */

/** What every handle starts with. Use it for SQL prefix filters (`LIKE`). */
export const HANDLE_PREFIX = 'legiscan:'

// Central bill ids are positive integers, so `legiscan:0` isn't a handle.
const HANDLE_RE = /^legiscan:([1-9]\d*)$/

/** The handle for central bill `id`. */
export function toHandle(id: number): string {
  return `${HANDLE_PREFIX}${id}`
}

/**
 * Central's bill id from a handle, or null for anything that isn't one: a
 * draft's null `external_id`, a legacy `ocd-bill/…` id, or a malformed string.
 */
export function parseHandle(handle: string | null | undefined): number | null {
  const m = handle ? HANDLE_RE.exec(handle) : null
  return m ? Number(m[1]) : null
}

/** Whether `value` is a handle for a central bill. */
export function isHandle(value: string | null | undefined): value is string {
  return parseHandle(value) !== null
}
