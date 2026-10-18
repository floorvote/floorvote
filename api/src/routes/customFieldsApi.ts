import { Hono } from 'hono'
import { eq, max, and, ne } from 'drizzle-orm'
import { getDb } from '../db/client'
import { customFieldDefinitions, savedViews } from '../db/schema'
import { detectOptionRenames, rewriteViewQuery, type OptionRename } from '../lib/savedViewRenames'
import { nowDb } from '../lib/dbTime'
import type { AppEnv } from '../types'

export const customFieldsApiRouter = new Hono<AppEnv>()

const VALID_TYPES = ['binary', 'dropdown', 'text', 'date'] as const

function parseOptions(raw: string | null): string[] | null {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'field'
}

async function uniqueSlug(db: ReturnType<typeof getDb>, name: string, excludeId?: string): Promise<string> {
  const base = toSlug(name)
  let candidate = base
  let suffix = 2
  while (true) {
    const condition = excludeId
      ? and(eq(customFieldDefinitions.slug, candidate), ne(customFieldDefinitions.id, excludeId))
      : eq(customFieldDefinitions.slug, candidate)
    const existing = await db.select({ id: customFieldDefinitions.id }).from(customFieldDefinitions).where(condition).get()
    if (!existing) return candidate
    candidate = `${base}_${suffix++}`
  }
}

// GET /admin/custom-fields — list all definitions ordered by displayOrder
customFieldsApiRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .orderBy(customFieldDefinitions.displayOrder)
    .all()

  // Backfill slugs for any fields created before the slug column existed
  for (const r of rows) {
    if (!r.slug) {
      const slug = await uniqueSlug(db, r.name)
      await db.update(customFieldDefinitions).set({ slug }).where(eq(customFieldDefinitions.id, r.id))
      r.slug = slug
    }
  }

  return c.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      type: r.type,
      options: parseOptions(r.options),
      multiple: r.multiple,
      displayOrder: r.displayOrder,
      pinned: r.pinned,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  )
})

// POST /admin/custom-fields — create a field
customFieldsApiRouter.post('/', async (c) => {
  const body = await c
    .req
    .json<{ name?: string; type?: string; options?: unknown; multiple?: boolean }>()
    .catch(() => ({} as { name?: string; type?: string; options?: unknown; multiple?: boolean }))

  if (!body.name?.trim()) {
    return c.json({ error: 'name is required' }, 400)
  }
  if (!body.type || !(VALID_TYPES as readonly string[]).includes(body.type)) {
    return c.json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` }, 400)
  }

  if (body.type === 'dropdown') {
    if (!Array.isArray(body.options) || body.options.length === 0) {
      return c.json({ error: 'dropdown type requires a non-empty options array' }, 400)
    }
  }

  const multiple = body.type === 'dropdown' && body.multiple === true

  const db = getDb(c.env.DB)

  const maxRow = await db
    .select({ maxOrder: max(customFieldDefinitions.displayOrder) })
    .from(customFieldDefinitions)
    .get()
  const displayOrder = (maxRow?.maxOrder ?? -1) + 1

  const id = crypto.randomUUID()
  const now = nowDb()
  const options = body.type === 'dropdown' ? JSON.stringify(body.options) : null
  const slug = await uniqueSlug(db, body.name.trim())

  await db.insert(customFieldDefinitions).values({
    id,
    name: body.name.trim(),
    slug,
    type: body.type,
    options,
    multiple,
    displayOrder,
    createdAt: now,
    updatedAt: now,
  })

  return c.json({ id, name: body.name.trim(), slug, type: body.type, options: body.type === 'dropdown' ? body.options : null, multiple, displayOrder, pinned: false, createdAt: now, updatedAt: now }, 201)
})

// PUT /admin/custom-fields/reorder — bulk update displayOrder
// IMPORTANT: must be defined BEFORE /:id to avoid route conflicts
customFieldsApiRouter.put('/reorder', async (c) => {
  const body = await c.req.json<{ order: string[] }>().catch(() => ({ order: [] as string[] }))
  if (!Array.isArray(body.order)) {
    return c.json({ error: 'order must be an array of IDs' }, 400)
  }

  const db = getDb(c.env.DB)
  const now = nowDb()

  for (let i = 0; i < body.order.length; i++) {
    await db
      .update(customFieldDefinitions)
      .set({ displayOrder: i, updatedAt: now })
      .where(eq(customFieldDefinitions.id, body.order[i]))
  }

  return c.json({ ok: true })
})

// PUT /admin/custom-fields/:id — update name, options, and/or pinned
customFieldsApiRouter.put('/:id', async (c) => {
  const fieldId = c.req.param('id')
  const body = await c
    .req
    .json<{ name?: string; options?: unknown; pinned?: boolean; multiple?: boolean }>()
    .catch(() => ({} as { name?: string; options?: unknown; pinned?: boolean; multiple?: boolean }))

  const db = getDb(c.env.DB)
  const existing = await db
    .select()
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.id, fieldId))
    .get()

  if (!existing) return c.json({ error: 'Field not found' }, 404)

  const updates: Partial<typeof customFieldDefinitions.$inferInsert> = {
    updatedAt: nowDb(),
  }
  let optionRenames: OptionRename[] = []

  if (body.name !== undefined) {
    if (!body.name?.trim()) return c.json({ error: 'name cannot be empty' }, 400)
    updates.name = body.name.trim()
    updates.slug = await uniqueSlug(db, body.name.trim(), fieldId)
  }

  if (body.options !== undefined) {
    if (existing.type !== 'dropdown') {
      return c.json({ error: 'options can only be changed for dropdown type fields' }, 400)
    }
    if (!Array.isArray(body.options) || body.options.length === 0) {
      return c.json({ error: 'options must be a non-empty array' }, 400)
    }
    updates.options = JSON.stringify(body.options)
    optionRenames = detectOptionRenames(parseOptions(existing.options) ?? [], body.options as string[])
  }

  if (body.pinned !== undefined) {
    updates.pinned = body.pinned
  }

  if (body.multiple !== undefined) {
    if (existing.type !== 'dropdown') {
      return c.json({ error: 'multiple can only be set on dropdown type fields' }, 400)
    }
    if (existing.multiple && body.multiple === false) {
      // Block multi → single if any bill has 2+ values stored
      const conflictRows = await c.env.DB.prepare(`
        SELECT bill_id FROM bill_custom_field_values
        WHERE field_id = ?
          AND json_valid(value) = 1
          AND json_array_length(value) > 1
      `).bind(fieldId).all()
      const billIds = (conflictRows.results ?? []).map((r: any) => r.bill_id as string)
      if (billIds.length > 0) {
        return c.json({ error: 'multi_to_single_conflict', billIds }, 409)
      }
    }
    updates.multiple = body.multiple
  }

  const fieldUpdate = db.update(customFieldDefinitions).set(updates).where(eq(customFieldDefinitions.id, fieldId))

  // Saved views name a field by its slug and an option by its value, so a rename rewrites the views that use the
  // old ones. The field and its views change in one batch, which D1 runs as one transaction: all or none.
  const fromSlug = existing.slug
  const toSlug = updates.slug ?? existing.slug
  const viewUpdates = []
  if (fromSlug && (toSlug !== fromSlug || optionRenames.length > 0)) {
    const views = await db.select({ id: savedViews.id, query: savedViews.query }).from(savedViews).all()
    for (const view of views) {
      const query = rewriteViewQuery(view.query, { fromSlug, toSlug: toSlug ?? fromSlug, options: optionRenames })
      if (query !== null) {
        viewUpdates.push(db.update(savedViews).set({ query, updatedAt: nowDb() }).where(eq(savedViews.id, view.id)))
      }
    }
  }
  if (viewUpdates.length > 0) await db.batch([fieldUpdate, ...viewUpdates])
  else await fieldUpdate

  return c.json({ ok: true, slug: updates.slug ?? existing.slug })
})

// DELETE /admin/custom-fields/:id — delete field (cascade handles values)
customFieldsApiRouter.delete('/:id', async (c) => {
  const fieldId = c.req.param('id')
  const db = getDb(c.env.DB)

  const existing = await db
    .select({ id: customFieldDefinitions.id })
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.id, fieldId))
    .get()

  if (!existing) return c.json({ error: 'Field not found' }, 404)

  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, fieldId))

  return new Response(null, { status: 204 })
})
