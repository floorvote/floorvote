import { Hono } from 'hono'
import { getDb } from '../db/client'
import { savedViews } from '../db/schema'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

export type SavedViewDto = { id: string; name: string; query: string }

// Reads are member-accessible: every member can see and apply every view.
// Writes live under /api/admin/views instead — the same split /api/roles uses.
export const savedViewsRouter = new Hono<AppEnv>()

savedViewsRouter.use('*', requireAuth)

// GET /api/views — every view in the tenant, in creation order.
savedViewsRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db
    .select({ id: savedViews.id, name: savedViews.name, query: savedViews.query })
    .from(savedViews)
    .orderBy(savedViews.displayOrder)
    .all()
  return c.json({ views: rows satisfies SavedViewDto[] })
})
