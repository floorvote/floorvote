/**
 * Bill handles: how instances refer to a central bill. Instances store the
 * handle, `legiscan:<n>` where `<n>` is the bill's row id here, in a tenant
 * bill's `external_id`. The prefix is legacy and means "central bill," not
 * where the data came from (see **Bill handle** in CONTEXT.md).
 *
 * The handle is moving to a neutral prefix, `bill:<n>`, over two releases so
 * either deploy order is safe. Release 1 (this one): central accepts both
 * forms, and still sends only the legacy one. Release 2: central sends the
 * neutral form, by switching `toHandle`'s prefix after tenants migrate.
 *
 * Every place in central that builds or parses a handle goes through here.
 * The instance API and web app share their own copy in `shared/billHandle.ts`,
 * since central is a standalone package.
 */

/** The prefix `toHandle` builds: what central sends to tenants. */
const SENT_PREFIX = 'legiscan:'

// A bare id, or an id behind either prefix. Central bill ids are positive integers.
const HANDLE_RE = /^(?:(?:legiscan|bill):)?([1-9]\d*)$/

/** The handle for central bill `billId`, as queued to and stored by tenants. */
export function toHandle(billId: number): string {
  return `${SENT_PREFIX}${billId}`
}

/**
 * The central bill id in a route param or request body: a handle in either
 * form, or a bare id, which central's routes have always accepted too. Null
 * when there's no number to read.
 */
export function parseHandle(raw: string): number | null {
  const m = HANDLE_RE.exec(raw)
  return m ? Number(m[1]) : null
}

// Stubs for the red step of #647.
export const HANDLE_FORM_HEADER = ''
export function toLegacyHandle(billId: number): string { return toHandle(billId) }
export function toTenantHandle(billId: number, _neutral: boolean): string { return toHandle(billId) }
export function readsNeutralHandles(_value: string | null | undefined): boolean { return false }
