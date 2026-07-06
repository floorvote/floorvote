import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import { nowDb } from '../lib/dbTime'
import type { Env } from '../types'

export const statsRoutes = new Hono<{ Bindings: Env }>()

statsRoutes.post('/:id/stats', async (c) => {
  const tenantId = c.req.param('id')
  const body = await c.req.json<{
    statDate: string
    billsTracked?: number
    positionsTaken?: number
    votesCast?: number
    commentsAdded?: number
    activeMembers?: number
  }>()

  if (!body.statDate) return c.json({ error: 'statDate required' }, 400)

  const db = drizzle(c.env.DB, { schema })
  await db.insert(schema.tenantStats)
    .values({
      tenantId,
      statDate: body.statDate,
      billsTracked: body.billsTracked ?? 0,
      positionsTaken: body.positionsTaken ?? 0,
      votesCast: body.votesCast ?? 0,
      commentsAdded: body.commentsAdded ?? 0,
      activeMembers: body.activeMembers ?? 0,
    })
    .onConflictDoUpdate({
      target: [schema.tenantStats.tenantId, schema.tenantStats.statDate],
      set: {
        billsTracked: body.billsTracked ?? 0,
        positionsTaken: body.positionsTaken ?? 0,
        votesCast: body.votesCast ?? 0,
        commentsAdded: body.commentsAdded ?? 0,
        activeMembers: body.activeMembers ?? 0,
        reportedAt: nowDb(),
      },
    })

  return c.json({ ok: true })
})
