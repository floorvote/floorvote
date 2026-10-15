import { Hono, type Context } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { bills } from '../../db/schema'
import { groupByHand, loadGroupBills, planGroupByHand, previewSplit, splitFromGroup, type SplitConflict } from '../../lib/companionGroups'
import { pullCompanions } from '../../lib/companionAnalysis'
import { isHandle } from '../../../../shared/billHandle'
import type { AppEnv } from '../../types'

/**
 * Grouping and splitting bills by hand, from the bill page's overflow menu
 * (see **Group override** in CONTEXT.md). Admins only. The two writes answer with the
 * bill's group as it now stands, the bill first.
 */
export function registerGroupRoutes(router: Hono<AppEnv>) {
  /**
   * The two bills a grouping would join, or the response that refuses it. Shared by the grouping and its
   * preview, so the preview refuses exactly what the grouping would.
   */
  async function groupingPair(c: Context<AppEnv>) {
    const db = getDb(c.env.DB)
    const billId = c.req.param('id')!
    const body = c.req.method === 'GET' ? { withBillId: c.req.query('withBillId') } : await c.req.json().catch(() => ({})) as { withBillId?: unknown }
    const withBillId = body.withBillId
    if (typeof withBillId !== 'string' || withBillId === '') return { refusal: c.json({ error: 'withBillId is required' }, 400) }
    if (withBillId === billId) return { refusal: c.json({ error: 'A bill cannot be grouped with itself' }, 400) }

    const found = await db.select({ id: bills.id, billNumber: bills.billNumber, isDraft: bills.isDraft, externalId: bills.externalId, matchType: bills.matchType, groupKey: bills.groupKey })
      .from(bills).where(inArray(bills.id, [billId, withBillId])).all()
    if (found.length < 2) return { refusal: c.json({ error: 'Not found' }, 404) }
    // A draft has no legislative record to share a group with. Linking it to
    // its filed bill is how its engagement joins another bill.
    if (found.some(b => b.isDraft)) return { refusal: c.json({ error: 'A draft bill cannot be grouped. Link it to its filed bill instead.' }, 400) }
    // Already one group: a link here would change nothing now, and would only
    // pin the two together against what the provider later says.
    if (found[0].groupKey !== null && found[0].groupKey === found[1].groupKey) {
      return { refusal: c.json({ error: 'These bills are already in one group' }, 409) }
    }
    return { billId, withBillId, found }
  }

  /** The refusal for a conflict: name the split pair, and the way to undo its split. */
  function splitRefusal(c: Context<AppEnv>, conflict: SplitConflict, billId: string, found: Array<{ id: string; billNumber: string }>) {
    const [a, b] = conflict.split
    const number = (id: string) => found.find(f => f.id === id)!.billNumber
    const withBillId = found.find(f => f.id !== billId)!.id
    return c.json({
      error: `${a.billNumber} and ${b.billNumber} were split apart, and grouping ${number(billId)} with ${number(withBillId)} would group them again. To undo that split, group ${a.billNumber} with ${b.billNumber}.`,
    }, 409)
  }

  // POST /bills/:id/group { withBillId } — group this bill with another in the
  // instance. Each joins with its whole group. The answer reports the splits it
  // undid, a pair each by bill number.
  router.post('/:id/group', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const pair = await groupingPair(c)
    if ('refusal' in pair) return pair.refusal
    const { billId, withBillId, found } = pair

    const grouped = await groupByHand(db, billId, withBillId, c.get('user').id)
    if ('conflict' in grouped) return splitRefusal(c, grouped.conflict, billId, found)

    // A bill that didn't match, now grouped with a tracked one, is analyzed as
    // a delivery of the tracked bill would have it (lib/companionAnalysis.ts).
    const delivered = found.find(b => b.matchType !== null && isHandle(b.externalId)) ?? found.find(b => isHandle(b.externalId))
    if (delivered) await pullCompanions(c.env, db, { tenantId: c.env.TENANT_ID, billId: delivered.externalId! })

    return c.json({ groupBills: await loadGroupBills(db, billId), undoneSplitCount: grouped.undoneSplits.length, undoneSplits: grouped.undoneSplits })
  })

  // GET /bills/:id/group-preview?withBillId= — what grouping the two would undo,
  // written nowhere: { undoneSplits }, each split pair by bill number. Refuses
  // what the grouping would. The dialog's confirmation names them.
  router.get('/:id/group-preview', requireAdmin, async (c) => {
    const pair = await groupingPair(c)
    if ('refusal' in pair) return pair.refusal
    const { billId, withBillId, found } = pair
    const plan = await planGroupByHand(getDb(c.env.DB), billId, withBillId)
    if ('conflict' in plan) return splitRefusal(c, plan.conflict, billId, found)
    return c.json({ undoneSplits: plan.undoneSplits })
  })

  // GET /bills/:id/split-preview — what a split would leave, written nowhere:
  // { billNumber, parts }, the groups the rest of the group would fall into.
  // The page's confirmation names them.
  router.get('/:id/split-preview', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const billId = c.req.param('id')
    const bill = await db.select({ billNumber: bills.billNumber }).from(bills).where(eq(bills.id, billId)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    const parts = await previewSplit(db, billId)
    if (!parts) return c.json({ error: 'This bill is in no group' }, 409)
    return c.json({ billNumber: bill.billNumber, parts })
  })

  // POST /bills/:id/split — take this bill out of its group. The rest follow their own links.
  router.post('/:id/split', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const billId = c.req.param('id')
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, billId)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    if (!await splitFromGroup(db, billId, c.get('user').id)) return c.json({ error: 'This bill is in no group' }, 409)
    return c.json({ groupBills: await loadGroupBills(db, billId) })
  })
}
