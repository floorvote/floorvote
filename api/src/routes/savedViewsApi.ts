import { Hono } from 'hono'
import { eq, sql, and, ne } from 'drizzle-orm'
import { getDb } from '../db/client'
import { savedViews } from '../db/schema'
import { nowDb } from '../lib/dbTime'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

const MAX_VIEW_NAME_LENGTH = 120

function validateViewName(input: unknown): { value: string } | { error: string } {
  const name = typeof input === 'string' ? input.trim() : ''
  if (!name) {
    return { error: 'name is required' }
  }
  if (name.length > MAX_VIEW_NAME_LENGTH) {
    return { error: `name must be ${MAX_VIEW_NAME_LENGTH} characters or fewer` }
  }
  return { value: name }
}

export type SavedViewDto = { id: string; name: string; query: string; slug: string; previousSlug: string | null }

// Reads are member-accessible: every member can see and apply every view.
// Writes live under /api/admin/views instead — the same split /api/roles uses.
export const savedViewsRouter = new Hono<AppEnv>()

savedViewsRouter.use('*', requireAuth)

// Mirrors customFieldsApi's toSlug/uniqueSlug, but hyphenated rather than
// underscored — this slug is URL-facing (?view=clerk-bills), where
// customFieldsApi's feeds into a cf_<slug> query key instead.
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'view'
}

async function uniqueSlug(db: ReturnType<typeof getDb>, name: string, excludeId?: string): Promise<string> {
  const base = toSlug(name)
  let candidate = base
  let suffix = 2
  while (true) {
    const condition = excludeId
      ? and(eq(savedViews.slug, candidate), ne(savedViews.id, excludeId))
      : eq(savedViews.slug, candidate)
    const existing = await db.select({ id: savedViews.id }).from(savedViews).where(condition).get()
    if (!existing) return candidate
    candidate = `${base}-${suffix++}`
  }
}

// GET /api/views — every view in the tenant, in creation order.
savedViewsRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db
    .select({ id: savedViews.id, name: savedViews.name, query: savedViews.query, slug: savedViews.slug, previousSlug: savedViews.previousSlug })
    .from(savedViews)
    .orderBy(savedViews.displayOrder)
    .all()

  // Backfill slugs for any views created before the slug column existed
  // (mirrors customFieldsApi's GET / backfill loop).
  for (const r of rows) {
    if (!r.slug) {
      const slug = await uniqueSlug(db, r.name)
      await db.update(savedViews).set({ slug }).where(eq(savedViews.id, r.id))
      r.slug = slug
    }
  }

  const views: SavedViewDto[] = rows.map(r => ({
    id: r.id, name: r.name, query: r.query, slug: r.slug as string, previousSlug: r.previousSlug,
  }))
  return c.json({ views })
})

// ── Admin writes ──────────────────────────────────────────────────────────────
// Mounted under adminApiRouter, which already applies requireAuth + requireAdmin
// to '*', so no middleware is declared here.
export const adminSavedViewsRouter = new Hono<AppEnv>()

// POST /admin/views — capture the caller's current filter state under a name.
adminSavedViewsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: unknown; query?: unknown } | null
  const nameValidation = validateViewName(body?.name)
  if ('error' in nameValidation) return c.json({ error: nameValidation.error }, 400)
  const name = nameValidation.value
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  // A view with no filters would be indistinguishable from "All bills".
  if (!query) return c.json({ error: 'query is required' }, 400)

  const db = getDb(c.env.DB)
  const [{ next }] = await db
    .select({ next: sql<number>`COALESCE(MAX(${savedViews.displayOrder}), -1) + 1` })
    .from(savedViews)
    .all()

  const id = crypto.randomUUID()
  const slug = await uniqueSlug(db, name)
  await db.insert(savedViews).values({
    id, name, query, slug, createdBy: c.get('user').id, displayOrder: next,
  })
  return c.json({ id, name, query, slug }, 201)
})

// PUT /admin/views/reorder — bulk update displayOrder by array index.
// IMPORTANT: must be declared BEFORE /:id — Hono matches route registration
// order, so a /:id declared first would swallow "reorder" as an id.
adminSavedViewsRouter.put('/reorder', async (c) => {
  const body = await c.req.json<{ order: string[] }>().catch(() => ({ order: [] as string[] }))
  if (!Array.isArray(body.order)) {
    return c.json({ error: 'order must be an array of IDs' }, 400)
  }

  const db = getDb(c.env.DB)
  const now = nowDb()

  for (let i = 0; i < body.order.length; i++) {
    await db
      .update(savedViews)
      .set({ displayOrder: i, updatedAt: now })
      .where(eq(savedViews.id, body.order[i]))
  }

  return c.json({ ok: true })
})

// PUT /admin/views/:id — rename only. A view's query is never edited in place:
// re-saving from the list is the way to change what it matches, which keeps the
// stored query traceable to filter state someone actually looked at.
adminSavedViewsRouter.put('/:id', async (c) => {
  const body = await c.req.json().catch(() => null) as { name?: unknown } | null
  const nameValidation = validateViewName(body?.name)
  if ('error' in nameValidation) return c.json({ error: nameValidation.error }, 400)
  const name = nameValidation.value

  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const existing = await db
    .select({ query: savedViews.query, slug: savedViews.slug, name: savedViews.name })
    .from(savedViews)
    .where(eq(savedViews.id, id))
    .get()
  if (!existing) return c.json({ error: 'not found' }, 404)

  // Renaming regenerates the slug (mirroring customFieldsApi's uniqueSlug-on-
  // rename), so the bookmark URL matches what the view is now called. But a
  // bookmark taken under the OLD name must not silently stop resolving — the
  // just-superseded slug is carried into `previous_slug` and is still treated
  // as resolvable by the /views consumers (see savedViews.ts on the frontend).
  // This is one generation of back-compat, not a full rename history: a
  // second rename shifts previous_slug again, and the slug from two renames
  // ago stops resolving. That tradeoff is judged worth it here rather than
  // building out slug-history storage for a feature this size. If the name
  // is unchanged (or only differs in a way toSlug collapses away), the slug
  // — computed excluding this row from the uniqueness check — comes back
  // identical to the existing one, so previous_slug is left untouched rather
  // than being churned on every no-op rename.
  const newSlug = await uniqueSlug(db, name, id)
  const updates: Partial<typeof savedViews.$inferInsert> = { name, updatedAt: nowDb() }
  if (newSlug !== existing.slug) {
    updates.previousSlug = existing.slug
    updates.slug = newSlug
  }

  await db.update(savedViews).set(updates).where(eq(savedViews.id, id))
  return c.json({ id, name, query: existing.query, slug: updates.slug ?? existing.slug })
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
