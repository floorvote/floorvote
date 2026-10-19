import { inArray, sql, type SQL } from 'drizzle-orm'
import { billTexts } from '../db/schema'
import { chunk } from './chunk'
import type { AppDb } from '../types'

/**
 * A companion group's lead bill (see **Lead bill** in CONTEXT.md): the bill
 * the group's list row is about, and whose analysis (team summary and tags)
 * the group shows. One rule picks it everywhere:
 *
 * 1. the furthest along (the highest status rank),
 * 2. then the newest bill text (the latest date among the bill's texts; a
 *    bill with no texts comes after one with texts),
 * 3. then the natural bill number ("HB 9" before "HB 10"),
 * 4. then the smaller id, so every page picks the same one.
 *
 * `compareLead` is the rule in code, and `leadOrder` the same rule as SQL for
 * the list's sort keys. Migration 0113's `group_tags` triggers spell it out
 * again, since a trigger can't call either.
 */
export type LeadFields = { id: string; billNumber: string; statusRank: number; newestTextDate: string | null }

/** The group's bills in lead order: the lead first. */
export function compareLead(a: LeadFields, b: LeadFields): number {
  if (a.statusRank !== b.statusRank) return b.statusRank - a.statusRank
  const [da, db] = [a.newestTextDate || null, b.newestTextDate || null]
  if (da !== db) {
    if (da === null) return 1
    if (db === null) return -1
    return da > db ? -1 : 1
  }
  const [x, y] = [naturalParts(a.billNumber), naturalParts(b.billNumber)]
  if (x.prefix !== y.prefix) return x.prefix < y.prefix ? -1 : 1
  if (x.num !== y.num) return x.num - y.num
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The group's lead, or null for no members. */
export function pickLead<T extends LeadFields>(members: readonly T[]): T | null {
  let best: T | null = null
  for (const m of members) if (best === null || compareLead(m, best) < 0) best = m
  return best
}

// The same split as `billPrefix` and `billNum` below: the text before the first digit, and the number from it.
function naturalParts(number: string): { prefix: string; num: number } {
  const digit = /\d/.exec(number)
  if (!digit) return { prefix: number, num: 0 }
  return { prefix: number.slice(0, digit.index), num: Number.parseInt(number.slice(digit.index), 10) || 0 }
}

// ── The same rule as SQL ────────────────────────────────────────────────────

// Natural bill-number order: split into the text before the first digit and the
// number after it, so "HB 9" sorts before "HB 10".
// The digits are inlined, not bound, so the ORDER BY stays well under D1's 100-parameter limit.
const firstDigitPos = (n: SQL) => sql`min(${sql.join(
  Array.from({ length: 10 }, (_, d) => sql`CASE WHEN instr(${n}, ${sql.raw(`'${d}'`)}) = 0 THEN 99999 ELSE instr(${n}, ${sql.raw(`'${d}'`)}) END`),
  sql`, `,
)})`
export const billPrefix = (n: SQL) => sql`substr(${n}, 1, ${firstDigitPos(n)} - 1)`
export const billNum = (n: SQL) => sql`CAST(substr(${n}, ${firstDigitPos(n)}) AS INTEGER)`

/** The newest text date of the bill whose id is `billId`, or NULL when it has no texts. Read through idx_bill_texts_bill_date (migration 0113). */
export const newestTextDate = (billId: SQL) =>
  sql`(SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = ${billId})`

/**
 * A bill's newest text date when it is in a group, whose lead it can decide,
 * and NULL for a bill in no group, which is its own row: `table` is the bills
 * table or an alias of it. The one expression the list rows and the team field
 * reads use, so both feed `compareLead` the same value.
 */
export const groupedNewestTextDate = (table: { id: unknown; groupKey: unknown }) =>
  sql<string | null>`CASE WHEN ${table.groupKey} IS NULL THEN NULL ELSE ${newestTextDate(sql`${table.id}`)} END`

/** The ORDER BY terms that put a group's bills, as the table alias `g`, in lead order. */
export const leadOrder = (g: string): SQL => {
  const col = (name: string) => sql.raw(`${g}.${name}`)
  return sql`${col('status_rank')} DESC, ${newestTextDate(col('id'))} DESC NULLS LAST,
    ${billPrefix(col('bill_number'))} ASC, ${billNum(col('bill_number'))} ASC, ${col('id')} ASC`
}

// ── Reading the newest texts ────────────────────────────────────────────────

/** A bill's newest text: the latest date, a same-day tie to the higher document id, as the processor picks it. */
export type NewestText = { docId: string; date: string | null }

/** The newest text of each of these bills that has one. For a group's members, so a handful of bills. */
export async function readNewestTexts(db: AppDb, billIds: readonly string[]): Promise<Map<string, NewestText>> {
  const out = new Map<string, NewestText & { raw: string }>()
  for (const part of chunk([...new Set(billIds)], 90)) {
    const rows = await db.select({ billId: billTexts.billId, docId: billTexts.docId, date: billTexts.date })
      .from(billTexts).where(inArray(billTexts.billId, part)).all()
    for (const r of rows) {
      const held = out.get(r.billId)
      if (!held || newerText(r, { docId: held.docId, date: held.raw }) < 0) out.set(r.billId, { docId: r.docId, date: r.date || null, raw: r.date })
    }
  }
  return new Map([...out].map(([id, t]) => [id, { docId: t.docId, date: t.date }]))
}

// Doc ids are numeric strings and rise in issue order, so a same-day tie goes
// to the higher one, compared as numbers (the processor's pickLatestTextDocId).
function newerText(a: { docId: string; date: string }, b: { docId: string; date: string }): number {
  return b.date.localeCompare(a.date) || Number(b.docId) - Number(a.docId) || b.docId.localeCompare(a.docId)
}
