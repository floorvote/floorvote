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
 * A tenant row may be stored under either spelling while the rename rolls out,
 * so a lookup by handle matches both (`handleForms`), and a read from central
 * always uses the legacy spelling (`legacyHandle`).
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
 * form. Anything that isn't a handle comes back unchanged.
 */
export function normalizeHandle(handle: string): string
export function normalizeHandle(handle: string | null | undefined): string | null | undefined
export function normalizeHandle(handle: string | null | undefined): string | null | undefined {
  const id = parseHandle(handle)
  return id === null ? handle : toHandle(id)
}

/**
 * The legacy spelling of a handle that arrived in either form; anything that
 * isn't a handle comes back unchanged. Tenants ask central for a bill by this,
 * since a central that predates release 1 can't read a neutral handle.
 */
export function legacyHandle(handle: string): string {
  const id = parseHandle(handle)
  return id === null ? handle : toLegacyHandle(id)
}

/**
 * Every spelling a tenant row for this bill may be stored under, legacy first:
 * both for a handle, just the value for anything else. Release 2's migration
 * rewrites stored handles while a release-1 worker may still be running, so a
 * lookup by handle matches both (`inArray(col, handleForms(h))`) and never
 * inserts a second row for a bill held under the other spelling.
 */
export function handleForms(handle: string): string[] {
  const id = parseHandle(handle)
  return id === null ? [handle] : [toLegacyHandle(id), `${NEUTRAL_HANDLE_PREFIX}${id}`]
}

/**
 * Both spellings of every handle, in chunks of `size` for `inArray`: expand first,
 * then chunk, so a lookup of N bills binds N x 2 values and D1's 100-bind limit
 * holds at any N. Leave room in `size` for the query's other binds.
 */
export function chunkedForms(handles: Iterable<string>, size = 40): string[][] {
  const forms = [...new Set([...handles].flatMap(handleForms))]
  const out: string[][] = []
  for (let i = 0; i < forms.length; i += size) out.push(forms.slice(i, i + size))
  return out
}
