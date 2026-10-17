/**
 * Bill handles: how an instance refers to a central bill. A tenant bill's
 * `external_id` holds the handle, `legiscan:<n>`, where `<n>` is central's
 * bill row id. The prefix is legacy and means "central bill," not where the
 * data came from (see **Bill handle** in CONTEXT.md).
 *
 * The handle is moving to a neutral prefix, `bill:<n>`, over two releases so
 * either deploy order is safe. Release 1 (this one): every parser accepts both
 * forms, and everything still builds, sends, and stores the legacy form.
 * Release 2: a tenant migration rewrites stored handles and central sends the
 * neutral form, which is a one-line change to `STORED_PREFIX` below plus the
 * migration. Hearing UIDs are built from `toLegacyHandle` and stay legacy for
 * good, so subscribers' calendars never churn.
 *
 * Every place in the instance API and web app that builds or parses a handle
 * goes through here, so the format lives in one place. Central has its own
 * copy in `central/src/lib/billHandle.ts` (central is a standalone package).
 */

/** The legacy prefix. Hearing UIDs keep it permanently. */
export const LEGACY_HANDLE_PREFIX = 'legiscan:'
/** The neutral prefix, which names no provider. */
export const NEUTRAL_HANDLE_PREFIX = 'bill:'

/** Every prefix a handle can start with. Use it for SQL prefix filters (`LIKE`). */
export const HANDLE_PREFIXES = [LEGACY_HANDLE_PREFIX, NEUTRAL_HANDLE_PREFIX] as const

/**
 * The prefix `toHandle` builds and tenants store. Legacy through release 1;
 * release 2 switches it to the neutral prefix when it migrates stored handles.
 */
const STORED_PREFIX: (typeof HANDLE_PREFIXES)[number] = LEGACY_HANDLE_PREFIX

/** The prefix tenants store handles under. Kept for callers that filter on it. */
export const HANDLE_PREFIX = STORED_PREFIX

// Central bill ids are positive integers, so `legiscan:0` isn't a handle.
const HANDLE_RE = /^(?:legiscan|bill):([1-9]\d*)$/

/** The handle for central bill `id`, in the form tenants store. */
export function toHandle(id: number): string {
  return `${STORED_PREFIX}${id}`
}

/** The legacy handle for central bill `id`: the form hearing UIDs are built from, always. */
export function toLegacyHandle(id: number): string {
  return `${LEGACY_HANDLE_PREFIX}${id}`
}

/**
 * Central's bill id from a handle in either form, or null for anything that
 * isn't one: a draft's null `external_id`, a legacy `ocd-bill/…` id, or a
 * malformed string.
 */
export function parseHandle(handle: string | null | undefined): number | null {
  const m = handle ? HANDLE_RE.exec(handle) : null
  return m ? Number(m[1]) : null
}

/** Whether `value` is a handle for a central bill. */
export function isHandle(value: string | null | undefined): value is string {
  return parseHandle(value) !== null
}

/**
 * The form tenants store a handle under, for a handle that arrived in either
 * form. Anything that isn't a handle comes back unchanged, so the same bill
 * never gets two rows (or two companion links, or two calendar UIDs) because
 * central named it differently.
 */
export function normalizeHandle<T extends string | null | undefined>(handle: T): T {
  const id = parseHandle(handle)
  return (id === null ? handle : toHandle(id)) as T
}

// STUBS (red run only)
export function handleForms(handle: string): string[] { return [handle] }
export function legacyHandle(handle: string): string { return handle }
