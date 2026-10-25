import { eq } from 'drizzle-orm'
import { associationConfig, billSubjects } from '../db/schema'
import type { AppDb } from '../types'
import { MAX_SUBJECT_FILTERS } from '../../../shared/limits'
import { decodeSubjectFilter, encodeSubjectFilter } from '../../../shared/billFilter'

/**
 * Drop non-strings, empty strings, and duplicates, preserving first-occurrence
 * order. Shared by parseSubjects (reading bills.subjects back out) and
 * syncBillSubjects (writing bill_subjects) so a name list behaves identically
 * on both sides of the ingest — in particular so a duplicate or empty name
 * from LegiScan can never reach the (bill_id, subject_name) unique index.
 */
export function dedupeSubjectNames(items: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * Subject names as stored in bills.subjects (a JSON array). Deduped with
 * first-occurrence order preserved, mirroring filterTagsToTaxonomy's contract
 * so the two topical vocabularies behave the same way on read.
 */
export function parseSubjects(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return dedupeSubjectNames(parsed)
}

// The subject filter's wire form, `STATE:name`, is read and written by the bill filter
// (shared/billFilter), so the list, the facets, and the bulk routes decode it one way.
export { encodeSubjectFilter, decodeSubjectFilter }

// D1 rejects any statement with >100 bound params, and subjectMembership costs
// 2 params per value. Cap well under that so a huge or bookmarked filter list
// can't push a query (which may share the statement with other filters) over
// the limit and 500. A request over the cap is rejected with a 400, never
// truncated (decodeSubjectFiltersChecked).
// The number itself lives in shared/limits, where the web pickers read it too.
export { MAX_SUBJECT_FILTERS }

/**
 * Decode a raw list of `subject` query values, dropping malformed entries, and report whether the request
 * exceeded MAX_SUBJECT_FILTERS instead of silently dropping the remainder.
 *
 * No route calls this any more: the bill filter's parse (shared/billFilter) decodes the `subject` values of
 * every route, and `subjectCapError` (routes/billsApi/filterRequest) applies the cap. It stays, with its tests,
 * until it is deleted.
 *
 * Silently truncating a filter is actively wrong: under AND it returns MORE
 * bills than asked for, under match=any FEWER, with nothing to indicate it.
 * Routes reject an over-cap request; see
 * docs/superpowers/specs/2026-09-07-filter-group-operator-design.md.
 */
export function decodeSubjectFiltersChecked(
  values: string[],
): { filters: Array<{ state: string; name: string }>; overflow: boolean } {
  const filters: Array<{ state: string; name: string }> = []
  for (const value of values) {
    const decoded = decodeSubjectFilter(value)
    if (!decoded) continue
    if (filters.length >= MAX_SUBJECT_FILTERS) return { filters, overflow: true }
    filters.push(decoded)
  }
  return { filters, overflow: false }
}

/**
 * Replace a bill's subject rows. Delete-then-insert rather than a diff: central
 * does the same on its side, and a diff would have to reason about a partial
 * write. Safe to call with an empty list.
 *
 * `subjects` is deduped via dedupeSubjectNames before insert — LegiScan can send
 * the same subject name twice (distinct subject_ids across sessions), which
 * would otherwise violate the (bill_id, subject_name) primary key and throw,
 * wedging the queue message in a permanent retry loop (upsertBill already
 * committed, so bills.subjects and bill_subjects would then permanently
 * disagree). Insert is chunked at 30 rows (3 params/row = 90 params) — some
 * bills carry 100+ subjects, well over D1's 100-bound-param cap in one insert.
 *
 * The delete and the inserts run as one `db.batch`, which D1 runs as one
 * transaction (#848, as syncBillCommittees does, #471), so a write that fails
 * leaves the rows it would have replaced. Run as separate statements, an insert
 * that failed after the delete committed left the bill with no rows.
 *
 * The full delivery path puts these statements (`billSubjectStatements`) in
 * the one batch that also writes the bill and stamps its version (#906), so a
 * failed write is redone in full by the redelivery.
 */
const SUBJECTS_INSERT_CHUNK = 30

/** The statements that replace a bill's subject rows: the delete, then the chunked inserts. */
export function billSubjectStatements(db: AppDb, billInternalId: string, state: string, subjects: string[]) {
  const deduped = dedupeSubjectNames(subjects)
  const inserts = []
  for (let i = 0; i < deduped.length; i += SUBJECTS_INSERT_CHUNK) {
    const chunk = deduped.slice(i, i + SUBJECTS_INSERT_CHUNK)
    inserts.push(db.insert(billSubjects).values(
      chunk.map(name => ({ billId: billInternalId, subjectName: name, state })),
    ))
  }
  return [db.delete(billSubjects).where(eq(billSubjects.billId, billInternalId)), ...inserts] as const
}

export async function syncBillSubjects(
  db: AppDb, billInternalId: string, state: string, subjects: string[],
): Promise<void> {
  await db.batch(billSubjectStatements(db, billInternalId, state, subjects))
}

// ── Operator suppression switch ──────────────────────────────────────────
//
// association_config row, JSON array of state codes to hide the subjects
// feature for, with "*" meaning the whole tenant. Deliberately NOT modeled as
// a `modules` entry: isModuleEnabled() treats an absent `modules` row as every
// module OFF, and at least one production tenant (UT) — the tenant with the
// best subject data — has no `modules` row at all. A module entry would
// default the feature off for the tenant that most wants it on. This key's
// absence means the opposite: enabled everywhere, matching how a tenant with
// no association_config row sees subjects today. No admin UI writes this key;
// an operator sets it by hand, mirroring tag_taxonomy's resolution shape
// (loadEffectiveTaxonomy) — a row, JSON-decoded, empty/malformed treated as
// "not configured" rather than surfaced as an error.
export const SUPPRESSED_SUBJECT_STATES_KEY = 'subjects_suppressed_states'

/**
 * The set of suppressed states (or the literal "*" for the whole tenant).
 * Absent row, empty array, or malformed JSON all resolve to an empty set —
 * i.e. nothing suppressed — because this is a display/query filter for a
 * feature that is ON by default. Failing open (rather than closed, the way
 * loadEffectiveTaxonomy falls back to DEFAULT_TAXONOMY on a parse error) is
 * the only choice that can't silently take a working feature away from a
 * tenant over a typo in the stored JSON.
 */
export async function loadSuppressedSubjectStates(db: AppDb): Promise<Set<string>> {
  const row = await db.select().from(associationConfig)
    .where(eq(associationConfig.key, SUPPRESSED_SUBJECT_STATES_KEY)).get()
  if (!row) return new Set()
  let parsed: unknown
  try { parsed = JSON.parse(row.value) } catch { return new Set() }
  if (!Array.isArray(parsed)) return new Set()
  // Stored state codes are always uppercase; normalize configured codes the
  // same way so `["nj"]` suppresses NJ rather than silently no-op'ing. Only
  // strings are eligible for normalization — anything else is dropped exactly
  // as before, so a garbage entry can never be coerced into a match. Trimmed-
  // then-empty strings are also dropped rather than kept as a stray "" that
  // could never match a real state but would otherwise pollute the set.
  const out = new Set<string>()
  for (const v of parsed) {
    if (typeof v !== 'string') continue
    const normalized = v.trim().toUpperCase()
    if (normalized.length === 0) continue
    out.add(normalized)
  }
  return out
}

/** Whether `state`'s subjects are suppressed — either named directly or via the "*" wildcard. */
export function isSubjectsSuppressedForState(suppressed: ReadonlySet<string>, state: string): boolean {
  return suppressed.has('*') || suppressed.has(state)
}
