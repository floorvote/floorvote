import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { bills } from '../../db/schema'
import { groupByHand, loadGroupBills, splitFromGroup } from '../../lib/companionGroups'
import { pullCompanions } from '../../lib/companionAnalysis'
import { isHandle } from '../../../../shared/billHandle'
import type { AppEnv } from '../../types'

/**
 * Grouping and splitting bills by hand, from the bill page's overflow menu
 * (see **Group override** in CONTEXT.md). Admins only. Both answer with the
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

    const found = await db.select({ id: bills.id, isDraft: bills.isDraft, externalId: bills.externalId, matchType: bills.matchType })
      .from(bills).where(inArray(bills.id, [billId, withBillId])).all()
    if (found.length < 2) return c.json({ error: 'Not found' }, 404)
    // A draft has no legislative record to share a group with. Linking it to
    // its filed bill is how its engagement joins another bill.
    if (found.some(b => b.isDraft)) return c.json({ error: 'A draft bill cannot be grouped. Link it to its filed bill instead.' }, 400)

    await groupByHand(db, billId, withBillId, c.get('user').id)

    // A bill that didn't match, now grouped with a tracked one, is analyzed as
    // a delivery of the tracked bill would have it (lib/companionAnalysis.ts).
    const delivered = found.find(b => b.matchType !== null && isHandle(b.externalId)) ?? found.find(b => isHandle(b.externalId))
    if (delivered) await pullCompanions(c.env, db, { tenantId: c.env.TENANT_ID, billId: delivered.externalId! })

    return c.json({ groupBills: await loadGroupBills(db, billId) })
  })

  // POST /bills/:id/split — take this bill out of its group. The rest stay grouped.
  router.post('/:id/split', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const billId = c.req.param('id')
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, billId)).get()
    if (!bill) return c.json({ error: 'Not found' }, 404)
    if (!await splitFromGroup(db, billId, c.get('user').id)) return c.json({ error: 'This bill is in no group' }, 409)
    return c.json({ groupBills: await loadGroupBills(db, billId) })
  })
}
