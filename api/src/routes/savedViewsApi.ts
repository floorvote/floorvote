import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client'
import { savedViews } from '../db/schema'
import { nowDb } from '../lib/dbTime'
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

// ── Admin writes ──────────────────────────────────────────────────────────────
// Mounted under adminApiRouter, which already applies requireAuth + requireAdmin
// to '*', so no middleware is declared here.
export const adminSavedViewsRouter = new Hono<AppEnv>()

// POST /admin/views — capture the caller's current filter state under a name.
adminSavedViewsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: unknown; query?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  if (!name) return c.json({ error: 'name is required' }, 400)
  // Renders straight into the page's h1 row — an unbounded name would break that layout.
  if (name.length > 120) return c.json({ error: 'name must be 120 characters or fewer' }, 400)
  // A view with no filters would be indistinguishable from "All bills".
  if (!query) return c.json({ error: 'query is required' }, 400)

  const db = getDb(c.env.DB)
  const [{ next }] = await db
    .select({ next: sql<number>`COALESCE(MAX(${savedViews.displayOrder}), -1) + 1` })
    .from(savedViews)
    .all()

  const id = crypto.randomUUID()
  await db.insert(savedViews).values({
    id, name, query, createdBy: c.get('user').id, displayOrder: next,
  })
  return c.json({ id, name, query }, 201)
})

// PUT /admin/views/:id — rename only. A view's query is never edited in place:
// re-saving from the list is the way to change what it matches, which keeps the
// stored query traceable to filter state someone actually looked at.
adminSavedViewsRouter.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return c.json({ error: 'name is required' }, 400)

  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const existing = await db.select({ query: savedViews.query }).from(savedViews).where(eq(savedViews.id, id)).get()
  if (!existing) return c.json({ error: 'not found' }, 404)

  await db.update(savedViews).set({ name, updatedAt: nowDb() }).where(eq(savedViews.id, id))
  return c.json({ id, name, query: existing.query })
})

// DELETE /admin/views/:id — removes it for every member, which the UI confirms.
adminSavedViewsRouter.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const existing = await db.select({ id: savedViews.id }).from(savedViews).where(eq(savedViews.id, id)).get()
  if (!existing) return c.json({ error: 'not found' }, 404)

  await db.delete(savedViews).where(eq(savedViews.id, id))
  return c.body(null, 204)
})
