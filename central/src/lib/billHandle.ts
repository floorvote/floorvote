/**
 * Bill handles: how instances refer to a central bill. Instances store the
 * handle, `legiscan:<n>` where `<n>` is the bill's row id here, in a tenant
 * bill's `external_id`. The prefix is legacy and means "central bill," not
 * where the data came from (see **Bill handle** in CONTEXT.md).
 *
 * Every place in central that builds or parses a handle goes through here.
 * The instance API and web app share their own copy in `shared/billHandle.ts`,
 * since central is a standalone package.
 */

const HANDLE_PREFIX = 'legiscan:'

/** The handle for central bill `billId`, as queued to and stored by tenants. */
export function toHandle(billId: number): string {
  return `${HANDLE_PREFIX}${billId}`
}

/**
 * The central bill id in a route param or request body: a handle, or a bare
 * id, which central's routes have always accepted too. Null when there's no
 * number to read.
 */
export function parseHandle(raw: string): number | null {
  const n = parseInt(raw.startsWith(HANDLE_PREFIX) ? raw.slice(HANDLE_PREFIX.length) : raw, 10)
  return isNaN(n) ? null : n
}
