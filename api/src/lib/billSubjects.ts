import { eq } from 'drizzle-orm'
import { billSubjects } from '../db/schema'
import type { AppDb } from '../types'

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

/**
 * Filter values are namespaced by state because the vocabularies are not
 * comparable across states — New Jersey publishes 44 coarse terms, Arizona
 * 6,449 fine-grained ones. An unnamespaced "Education" would OR across both.
 */
export function encodeSubjectFilter(state: string, name: string): string {
  return `${state}:${name}`
}

/** Split on the FIRST colon only — subject names legitimately contain colons. */
export function decodeSubjectFilter(value: string): { state: string; name: string } | null {
  const idx = value.indexOf(':')
  if (idx <= 0) return null
  const state = value.slice(0, idx)
  const name = value.slice(idx + 1)
  if (name.length === 0) return null
  return { state, name }
}

// D1 rejects any statement with >100 bound params, and subjectMembership costs
// 2 params per value. Cap well under that so a huge or bookmarked filter list
// can't push a query (which may share the statement with other filters) over
// the limit and 500. Truncating silently keeps the page usable rather than
// erroring on an oversized but otherwise harmless URL.
export const MAX_SUBJECT_FILTERS = 40

/** Decode a raw list of `subject` query values, dropping malformed entries and
 *  capping the result at MAX_SUBJECT_FILTERS. Shared by every route that turns
 *  `?subject=` params into subjectMembership() input, so none of them can
 *  independently forget the cap or the decode rules. */
export function decodeSubjectFilters(values: string[]): Array<{ state: string; name: string }> {
  const out: Array<{ state: string; name: string }> = []
  for (const value of values) {
    const decoded = decodeSubjectFilter(value)
    if (!decoded) continue
    out.push(decoded)
    if (out.length >= MAX_SUBJECT_FILTERS) break
  }
  return out
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
 */
const SUBJECTS_INSERT_CHUNK = 30

export async function syncBillSubjects(
  db: AppDb, billInternalId: string, state: string, subjects: string[],
): Promise<void> {
  await db.delete(billSubjects).where(eq(billSubjects.billId, billInternalId)).run()
  const deduped = dedupeSubjectNames(subjects)
  if (deduped.length === 0) return
  for (let i = 0; i < deduped.length; i += SUBJECTS_INSERT_CHUNK) {
    const chunk = deduped.slice(i, i + SUBJECTS_INSERT_CHUNK)
    await db.insert(billSubjects).values(
      chunk.map(name => ({ billId: billInternalId, subjectName: name, state })),
    ).run()
  }
}
