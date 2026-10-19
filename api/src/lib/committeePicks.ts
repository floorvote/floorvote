import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { associationConfig, billCommittees, bills } from '../db/schema'
import { matchesKeywords, billMatchText } from './keywords'
import type { AppDb } from '../types'

/**
 * Committee picks (#471): the committees an admin picks in the Bill committees card, stored in the config as
 * `bill_committees` (central committee ids, as strings) and sent to central at registration. Central fully analyzes a
 * bill referred to a picked committee as it does a keyword match, so the picks cost what keyword matches of the same
 * bills would.
 */

/** Each committee's bill count and name, by id, and each state's bill count: what the card sizes committees against. */
export type CommitteeSizes = {
  counts: Record<string, number>
  info: Record<string, { name: string; state: string; chamber: string | null }>
  stateTotals: Record<string, number>
}

/**
 * The running total for a set of picks. `total` is every bill the instance holds, `analyzed` the bills that would be
 * fully analyzed (keyword matches, bills added by hand, and bills in a picked committee), and `added` the bills in a
 * picked committee that are not analyzed now, which saving would have central fetch and the AI analyze.
 */
export type CommitteeAnalysisSummary = { total: number; analyzed: number; added: number }

/** The config key the picks are saved under. */
export const COMMITTEE_PICKS_KEY = 'bill_committees'

/** Whether a value is a list of committee ids: central's ids are whole numbers, sent as strings. */
export function isCommitteeIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && /^\d{1,15}$/.test(v))
}

/** The saved picks, or none. */
export async function readCommitteePicks(db: AppDb): Promise<string[]> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, COMMITTEE_PICKS_KEY)).get()
  if (!row) return []
  try {
    const value: unknown = JSON.parse(row.value)
    return isCommitteeIdList(value) ? value : []
  } catch {
    return []
  }
}

/** The bills a draft is not: those central sent. */
const heldBill = and(isNotNull(bills.externalId), eq(bills.isDraft, false))

/**
 * Each committee's size: the bills the instance holds that were referred to it or are pending in it, its name (a
 * renamed committee keeps its old name on a bill until that bill's next delivery, so the largest is taken, as the
 * Committee filter does), and each state's bill count.
 */
export async function committeeSizes(db: AppDb): Promise<CommitteeSizes> {
  const rows = await db.select({
    id: billCommittees.committeeId,
    state: billCommittees.state,
    name: sql<string>`MAX(${billCommittees.name})`,
    chamber: sql<string | null>`MAX(${billCommittees.chamber})`,
    n: sql<number>`COUNT(*)`,
  }).from(billCommittees).innerJoin(bills, eq(bills.id, billCommittees.billId)).where(heldBill)
    .groupBy(billCommittees.committeeId).all()
  const totals = await db.select({ state: bills.state, n: sql<number>`COUNT(*)` }).from(bills).where(heldBill).groupBy(bills.state).all()
  return {
    counts: Object.fromEntries(rows.map(r => [r.id, r.n])),
    info: Object.fromEntries(rows.map(r => [r.id, { name: r.name, state: r.state, chamber: r.chamber }])),
    stateTotals: Object.fromEntries(totals.map(r => [r.state, r.n])),
  }
}

/** The bills (by instance id) referred to or pending in any of `committeeIds`. */
export async function billsInCommittees(db: AppDb, committeeIds: readonly string[]): Promise<Set<string>> {
  if (committeeIds.length === 0) return new Set()
  const rows = await db.selectDistinct({ id: billCommittees.billId }).from(billCommittees)
    .where(sql`${billCommittees.committeeId} IN (SELECT value FROM json_each(${JSON.stringify(committeeIds)}))`).all()
  return new Set(rows.map(r => r.id))
}

/**
 * The running total for `picks` with the saved `keywords` (see `CommitteeAnalysisSummary`). A bill the keywords
 * matched once and no longer do counts only if a pick holds it, as saving would downgrade it otherwise. Reads every
 * bill's match text, as the keyword match summary does.
 */
export async function summarizeCommitteePicks(db: AppDb, picks: readonly string[], keywords: readonly string[]): Promise<CommitteeAnalysisSummary> {
  const inPicks = await billsInCommittees(db, picks)
  const rows = await db.select({ id: bills.id, title: bills.title, abstract: bills.abstract, billNumber: bills.billNumber, matchType: bills.matchType })
    .from(bills).where(heldBill).all()
  const kws = [...keywords]
  let analyzed = 0
  let added = 0
  for (const b of rows) {
    const picked = inPicks.has(b.id)
    const kept = b.matchType === 'manual'
      || (kws.length > 0 && matchesKeywords(billMatchText({ title: b.title, description: b.abstract, billNumber: b.billNumber }), kws))
    if (kept || picked) analyzed++
    if (picked && b.matchType === null) added++
  }
  return { total: rows.length, analyzed, added }
}
