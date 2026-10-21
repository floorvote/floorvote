import { HANDLE_FORM_HEADER, HANDLE_FORM_NEUTRAL } from '../../../shared/billHandle'

/**
 * Bill handles: how instances refer to a central bill. Instances store the
 * handle, `bill:<n>` where `<n>` is the bill's row id here, in a tenant bill's
 * `external_id`. It means "central bill," not where the data came from (see
 * **Bill handle** in CONTEXT.md).
 *
 * The handle moved from the legacy prefix, `legiscan:<n>`, to the neutral one
 * over two releases so either deploy order is safe (#305). Release 1: central
 * accepts both forms. Release 2 (this one): `toHandle` builds the neutral form,
 * and central sends it only to an instance that says it reads it, because an
 * instance that predates release 1 would store `bill:<n>` as a second bill and
 * build new calendar UIDs from it. Every other instance gets `toLegacyHandle`.
 * Messages queued to an instance take its form in `lib/tenantDelivery.ts`
 * (`lib/tenantHandles.ts` asks the instance), and an answer to an instance's
 * request takes the form its `HANDLE_FORM_HEADER` names (`readsNeutralHandles`).
 *
 * Every place in central that builds or parses a handle goes through here.
 * The instance API and web app share their own copy in `shared/billHandle.ts`,
 * since central is a standalone package.
 */

export { HANDLE_FORM_HEADER }

/** The prefix `toHandle` builds: neutral, which names no provider. */
const SENT_PREFIX = 'bill:'
/** The legacy prefix, for an instance that doesn't read the neutral one. */
const LEGACY_PREFIX = 'legiscan:'

// A bare id, or an id behind either prefix. Central bill ids are positive integers.
const HANDLE_RE = /^(?:(?:legiscan|bill):)?([1-9]\d*)$/
// A handle behind either prefix, never a bare id: what a message to an instance names a bill by.
const PREFIXED_RE = /^(?:legiscan|bill):([1-9]\d*)$/

/** The neutral handle for central bill `billId`. */
export function toHandle(billId: number): string {
  return `${SENT_PREFIX}${billId}`
}

/** The legacy handle for central bill `billId`, for an instance that doesn't read neutral ones. */
export function toLegacyHandle(billId: number): string {
  return `${LEGACY_PREFIX}${billId}`
}

/** The handle for central bill `billId` in the form an instance reads. */
export function toTenantHandle(billId: number, neutral: boolean): string {
  return neutral ? toHandle(billId) : toLegacyHandle(billId)
}

/**
 * A handle in either form, in the form an instance reads. Anything else, a
 * bare id or a malformed value included, comes back unchanged.
 */
export function inTenantForm(handle: string, neutral: boolean): string {
  const m = PREFIXED_RE.exec(handle)
  return m ? toTenantHandle(Number(m[1]), neutral) : handle
}

/** Whether a request's `HANDLE_FORM_HEADER` value says the instance reads neutral handles. */
export function readsNeutralHandles(value: string | null | undefined): boolean {
  return value === HANDLE_FORM_NEUTRAL
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
