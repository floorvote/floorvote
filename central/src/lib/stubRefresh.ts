import { sql } from 'drizzle-orm'
import { bills } from '../db/schema'
import { DEFAULT_PROVIDER_ID } from '../providers'
import { getSettingNumber } from './settings'
import { legiscanCallsOnly, monthStartDb } from './legiscanBudget'
import { apiCallLog } from '../db/schema'
import type { BillMessage, Db } from '../types'

/**
 * Refreshing a stub bill's detail when its page is viewed and the detail is
 * stale (GET /bills/:id?view=1).
 *
 * A stub is a bill no instance tracks. The master-list sync keeps its title,
 * status, and last action fresh, but its detail (actions, referrals, pending
 * committee, sponsors, texts, votes) only as of its last getBill, which costs a
 * call against LegiScan's monthly budget. So the detail is fetched again only
 * when someone opens the bill, at most once per change to it, and only while
 * the month's calls leave the floor below untouched. Until the fetch lands the
 * bill page keeps its gap notice. Other providers' bills are left to their own
 * syncs (#394).
 */

/** LegiScan, whose getBill is metered. Its bills are the only ones this path refreshes. */
const METERED_PROVIDER = DEFAULT_PROVIDER_ID

/**
 * The share of the monthly LegiScan limit that view refreshes leave for the
 * sync of tracked bills. A refresh is skipped once it would leave fewer calls
 * than this.
 */
export const STUB_REFRESH_BUDGET_FLOOR = 0.25

/**
 * How long a queued refresh holds off another for the same change. One that
 * never lands (its getBill failed past the queue's retries) is queued again by
 * the first view after this, so a failing bill costs a few calls a day at most.
 */
export const STUB_REFRESH_RETRY_HOURS = 24

export type StubRefreshRow = {
  billId: number
  provider: string
  changeHash: string
  detailHash: string | null
  detailRequestedHash: string | null
  detailRequestedAt: string | null
}

/** The detail is stale when it was fetched at another change than the bill is at, or never fetched. */
export function isDetailStale(bill: Pick<StubRefreshRow, 'changeHash' | 'detailHash'>): boolean {
  return bill.detailHash !== bill.changeHash
}

const dbTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ') // ts-write-ok: compared to stored times, written only through nowDb's format
const retryCutoff = (now: Date) => dbTime(new Date(now.getTime() - STUB_REFRESH_RETRY_HOURS * 3600_000))

/**
 * Whether a view may queue a refresh of the bill: a LegiScan bill whose detail
 * is stale, with no refresh queued for its current change, or only one older
 * than the retry window. Whether an instance tracks it is checked when the
 * refresh is claimed.
 */
export function refreshDue(bill: StubRefreshRow, now: Date): boolean {
  if (bill.provider !== METERED_PROVIDER || !isDetailStale(bill)) return false
  if (bill.detailRequestedHash !== bill.changeHash || !bill.detailRequestedAt) return true
  return bill.detailRequestedAt <= retryCutoff(now)
}

/** The calls a refresh must leave unspent: STUB_REFRESH_BUDGET_FLOOR of the limit, rounded up. */
export function stubRefreshFloor(limit: number): number {
  return Math.ceil(limit * STUB_REFRESH_BUDGET_FLOOR)
}

/**
 * The most calls the month may have used for a refresh to go ahead: the limit
 * less the floor, less the one call the refresh spends. -1 when the limit is
 * unset or not a positive number, which no count is at or under.
 */
export function stubRefreshMaxUsed(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return -1
  return limit - stubRefreshFloor(limit) - 1
}

/** Whether a refresh may spend a call with `used` of the month's `limit` gone: it must leave the floor. */
export function budgetAllowsStubRefresh(used: number, limit: number): boolean {
  return used <= stubRefreshMaxUsed(limit)
}

/**
 * Queue one detail fetch for a stale stub, unless another view already did for
 * this change or the budget is at its floor. Returns whether it queued one.
 *
 * The claim is one UPDATE, which D1 runs alone, so of any number of concurrent
 * views exactly one claims a given change. The same statement re-checks the
 * bill (still stale, still LegiScan's, still tracked by no instance) and the
 * budget: the month's LegiScan calls plus the refreshes queued within the
 * retry window that haven't landed, whose calls aren't logged yet. So a burst
 * of views across many stubs stops at the floor too. The message is sent only
 * once the claim is won, and the claim is released if the send fails, so the
 * next view tries again.
 */
export async function refreshStaleStub(db: Db, queue: Queue, bill: StubRefreshRow, now: Date = new Date()): Promise<boolean> {
  if (!refreshDue(bill, now)) return false
  const maxUsed = stubRefreshMaxUsed(await getSettingNumber(db, 'legiscan_monthly_limit', 10000))
  if (maxUsed < 0) return false

  const at = dbTime(now)
  const cutoff = retryCutoff(now)
  const claimed = await db.update(bills)
    .set({ detailRequestedHash: sql`${bills.changeHash}`, detailRequestedAt: at })
    .where(sql`${bills.billId} = ${bill.billId}
      AND ${bills.provider} = ${METERED_PROVIDER}
      AND ${bills.detailHash} IS NOT ${bills.changeHash}
      AND (${bills.detailRequestedHash} IS NOT ${bills.changeHash} OR ${bills.detailRequestedAt} IS NULL OR ${bills.detailRequestedAt} <= ${cutoff})
      AND NOT EXISTS (SELECT 1 FROM bill_tenants bt WHERE bt.bill_id = ${bills.billId} AND bt.match_type IS NOT NULL)
      AND (SELECT COUNT(*) FROM ${apiCallLog} WHERE ${apiCallLog.loggedAt} >= ${monthStartDb(now)} AND ${legiscanCallsOnly})
        + (SELECT COUNT(*) FROM bills pending WHERE pending.detail_requested_at > ${cutoff}
            AND pending.detail_hash IS NOT pending.detail_requested_hash)
        <= ${maxUsed}`)
    .returning({ changeHash: bills.changeHash })
  if (claimed.length === 0) return false

  const message: BillMessage = { billId: bill.billId, queuedBy: METERED_PROVIDER }
  try {
    await queue.send(message)
  } catch (err) {
    console.error(`[stub-refresh] could not queue bill ${bill.billId}; releasing its claim`, err)
    await db.update(bills)
      .set({ detailRequestedHash: null, detailRequestedAt: null })
      .where(sql`${bills.billId} = ${bill.billId} AND ${bills.detailRequestedAt} = ${at} AND ${bills.detailRequestedHash} = ${claimed[0].changeHash}`)
    return false
  }
  console.log(`[stub-refresh] queued a detail refresh of bill ${bill.billId} at change ${claimed[0].changeHash}`)
  return true
}
