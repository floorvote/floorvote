import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { bills } from '../../db/schema'
import { groupByHand, loadGroupBills, previewSplit, splitFromGroup } from '../../lib/companionGroups'
import { pullCompanions } from '../../lib/companionAnalysis'
import { isHandle } from '../../../../shared/billHandle'
import type { AppEnv } from '../../types'

/**
 * Grouping and splitting bills by hand, from the bill page's overflow menu
 * (see **Group override** in CONTEXT.md). Admins only. The two writes answer with the
 * bill's group as it now stands, the bill first.
 */
export function registerGroupRoutes(router: Hono<AppEnv>) {
  // POST /bills/:id/group { withBillId } — group this bill with another in the
  // instance. Each joins with its whole group.
  router.post('/:id/group', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const billId = c.req.param('id')
    const body = await c.req.json().catch(() => ({})) as { withBillId?: unknown }
    const withBillId = body.withBillId
    if (typeof withBillId !== 'string' || withBillId === '') return c.json({ error: 'withBillId is required' }, 400)
    if (withBillId === billId) return c.json({ error: 'A bill cannot be grouped with itself' }, 400)

    const found = await db.select({ id: bills.id, billNumber: bills.billNumber, isDraft: bills.isDraft, externalId: bills.externalId, matchType: bills.matchType, groupKey: bills.groupKey })
      .from(bills).where(inArray(bills.id, [billId, withBillId])).all()
    if (found.length < 2) return c.json({ error: 'Not found' }, 404)
    // A draft has no legislative record to share a group with. Linking it to
    // its filed bill is how its engagement joins another bill.
    if (found.some(b => b.isDraft)) return c.json({ error: 'A draft bill cannot be grouped. Link it to its filed bill instead.' }, 400)
    // Already one group: a link here would change nothing now, and would only
    // pin the two together against what the provider later says.
    if (found[0].groupKey !== null && found[0].groupKey === found[1].groupKey) {
      return c.json({ error: 'These bills are already in one group' }, 409)
    }

    const conflict = await groupByHand(db, billId, withBillId, c.get('user').id)
    if (conflict) {
      // A split is a cannot-link: name the pair, and the way to undo its split.
      const [a, b] = conflict.split
      const number = (id: string) => found.find(f => f.id === id)!.billNumber
      return c.json({
        error: `${a.billNumber} and ${b.billNumber} were split apart, and grouping ${number(billId)} with ${number(withBillId)} would group them again. To undo that split, group ${a.billNumber} with ${b.billNumber}.`,
      }, 409)
    }

    // A bill that didn't match, now grouped with a tracked one, is analyzed as
    // a delivery of the tracked bill would have it (lib/companionAnalysis.ts).
    const delivered = found.find(b => b.matchType !== null && isHandle(b.externalId)) ?? found.find(b => isHandle(b.externalId))
    if (delivered) await pullCompanions(c.env, db, { tenantId: c.env.TENANT_ID, billId: delivered.externalId! })

    return c.json({ groupBills: await loadGroupBills(db, billId) })
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
