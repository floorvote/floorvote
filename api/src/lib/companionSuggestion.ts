import { and, eq, ne, or, sql } from 'drizzle-orm'
import { bills, companionSuggestionDismissals } from '../db/schema'
import { titleCompanionPairs } from '../../../shared/titleCompanions'
import type { AppDb } from '../types'

/**
 * Companion suggestions from matching titles (#521; see **Title-matched
 * suggestion** in CONTEXT.md). Central serves each bill's title key, its bill
 * type and normalized title, only in states its provider opts in. Every
 * delivery stores it with the bill's chamber, and an admin's view of a bill
 * looks up the bills of the same state and session that hold the bill's key,
 * through idx_bills_title_key (migration 0110). The pairing rule itself is
 * shared (`shared/titleCompanions.ts`).
 *
 * Accepting a suggestion is grouping by hand (`POST /bills/:id/group`), so it
 * writes the same link override and grouping events. A dismissal is kept per
 * pair in `companion_suggestion_dismissals`.
 */

/**
 * Store the title key and chamber central served for a bill, on every
 * delivery, whichever path the processor took, so opting a state in or out
 * reaches the bill on its next delivery. One statement that writes only when
 * either changed. An older central sends neither, which stores none.
 */
export async function syncTitleKey(db: AppDb, externalId: string, central: { titleKey?: string | null; body?: string | null }): Promise<void> {
  const key = central.titleKey || null
  const chamber = central.body || null
  await db.update(bills)
    .set({ titleKey: key, chamber })
    .where(and(eq(bills.externalId, externalId), or(sql`${bills.titleKey} IS NOT ${key}`, sql`${bills.chamber} IS NOT ${chamber}`)))
}

/** The bill a suggestion names, enough for a badge linking to its page. */
export interface CompanionSuggestion {
  billId: string
  billNumber: string
  state: string
  sessionSlug: string | null
}

/**
 * The bill to suggest grouping `bill` with, or null. `live` is what central
 * served for the bill on this view: its key is checked today, so a state
 * opted out since the bill's last delivery suggests nothing even while stored
 * keys still match. The other bill's key and chamber are the stored ones.
 *
 * Suggested only when the other bill is the one bill of the same state and
 * session holding the key, in another chamber (the shared rule), at least one
 * of the two is tracked, neither is in a companion group yet, and no override
 * (a split, or a link) or dismissal names the pair.
 *
 * Two statements, both indexed: the lookup reads at most two rows of
 * idx_bills_title_key, since a third means three bills share the title, and
 * the pair's override and dismissal are read by primary key.
 */
export async function findCompanionSuggestion(
  db: AppDb,
  bill: { id: string; state: string; sessionId: string | null; matchType: string | null; groupKey: string | null },
  live: { titleKey?: string | null; body?: string | null } | null,
): Promise<CompanionSuggestion | null> {
  const key = live?.titleKey || null
  const chamber = live?.body || null
  if (!key || !chamber || !bill.sessionId || !bill.state) return null

  const others = await db.select({
    id: bills.id, billNumber: bills.billNumber, state: bills.state, sessionSlug: bills.sessionSlug,
    sessionId: bills.sessionId, chamber: bills.chamber, titleKey: bills.titleKey,
    matchType: bills.matchType, groupKey: bills.groupKey,
  })
    .from(bills)
    .where(and(eq(bills.state, bill.state), eq(bills.sessionId, bill.sessionId), eq(bills.titleKey, key), ne(bills.id, bill.id)))
    .limit(2)
    .all()

  const self = { id: bill.id, sessionId: bill.sessionId, chamber, titleKey: key }
  const pair = titleCompanionPairs([self, ...others]).find(([a, b]) => a.id === bill.id || b.id === bill.id)
  if (!pair) return null
  const otherId = pair[0].id === bill.id ? pair[1].id : pair[0].id
  const other = others.find(o => o.id === otherId)!

  if (bill.matchType === null && other.matchType === null) return null
  // A bill in a group already has its companions settled, by the provider or an admin. Suggesting another would
  // only invite joining two groups, which a split between them can refuse.
  if (bill.groupKey !== null || other.groupKey !== null) return null

  const [low, high] = bill.id < other.id ? [bill.id, other.id] : [other.id, bill.id]
  const named = await db.get<{ overridden: number; dismissed: number }>(sql`SELECT
    EXISTS (SELECT 1 FROM bill_group_overrides WHERE bill_id = ${low} AND other_bill_id = ${high}) AS overridden,
    EXISTS (SELECT 1 FROM companion_suggestion_dismissals WHERE bill_id = ${low} AND other_bill_id = ${high}) AS dismissed`)
  if (named?.overridden || named?.dismissed) return null

  return { billId: other.id, billNumber: other.billNumber, state: other.state, sessionSlug: other.sessionSlug }
}

/**
 * Keep the pair from being suggested again on this instance. Idempotent: a
 * pair already dismissed keeps its first dismissal.
 */
export async function dismissSuggestion(db: AppDb, billId: string, otherBillId: string, actorUserId: string): Promise<void> {
  const [low, high] = billId < otherBillId ? [billId, otherBillId] : [otherBillId, billId]
  await db.insert(companionSuggestionDismissals)
    .values({ billId: low, otherBillId: high, actorUserId })
    .onConflictDoNothing()
}
