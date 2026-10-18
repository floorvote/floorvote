import { Hono } from 'hono'
import { eq, max, and, ne } from 'drizzle-orm'
import { getDb } from '../db/client'
import { customFieldDefinitions, savedViews } from '../db/schema'
import { billValueRenameStatements, validateOptionRenames, rewriteViewQuery, type OptionRename } from '../lib/savedViewRenames'
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
    .json<{ name?: string; options?: unknown; renames?: unknown; pinned?: boolean; multiple?: boolean }>()
    .catch(() => ({} as { name?: string; options?: unknown; renames?: unknown; pinned?: boolean; multiple?: boolean }))

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
    const checked = validateOptionRenames(body.renames, parseOptions(existing.options) ?? [], body.options as string[])
    if ('error' in checked) return c.json({ error: checked.error }, 400)
    optionRenames = checked.renames
  } else if (body.renames !== undefined) {
    return c.json({ error: 'renames can only be sent with options' }, 400)
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

  // Saved views name a field by its slug and an option by its value, and bills hold an option by its value, so a
  // rename moves all three: the field, the views that use it, and the bill values. They change in one batch,
  // which D1 runs as one transaction. Each write names what it read (the field's slug, options, and updated_at, a
  // view's query), and a closing statement fails the batch when any of them did not land, so a rename that
  // raced another edit answers 409 and writes nothing, instead of overwriting it.
  const fromSlug = existing.slug
  const toSlug = updates.slug ?? existing.slug
  if (!fromSlug || (toSlug === fromSlug && optionRenames.length === 0)) {
    await db.update(customFieldDefinitions).set(updates).where(eq(customFieldDefinitions.id, fieldId))
    return c.json({ ok: true, slug: updates.slug ?? existing.slug })
  }

  const D = c.env.DB
  const columns: Record<string, string> = { name: 'name', slug: 'slug', options: 'options', multiple: 'multiple', pinned: 'pinned', updatedAt: 'updated_at' }
  const set = Object.keys(updates).filter(k => k in columns)
  const values = set.map(k => {
    const v = (updates as Record<string, unknown>)[k]
    return typeof v === 'boolean' ? (v ? 1 : 0) : v
  })
  const finalSlug = toSlug as string
  const finalOptions = updates.options ?? existing.options
  const statements: D1PreparedStatement[] = [
    D.prepare(`UPDATE custom_field_definitions SET ${set.map(k => `${columns[k]} = ?`).join(', ')} WHERE id = ? AND slug IS ? AND options IS ? AND updated_at IS ?`)
      .bind(...values, fieldId, existing.slug, existing.options, existing.updatedAt),
  ]
  const rewritten: { id: string; query: string }[] = []
  const views = await db.select({ id: savedViews.id, query: savedViews.query }).from(savedViews).all()
  for (const view of views) {
    const query = rewriteViewQuery(view.query, { fromSlug, toSlug: finalSlug, options: optionRenames })
    if (query === null) continue
    rewritten.push({ id: view.id, query })
    statements.push(D.prepare(`UPDATE saved_views SET query = ?, updated_at = ? WHERE id = ? AND query = ?`).bind(query, nowDb(), view.id, view.query))
  }
  for (const s of billValueRenameStatements(fieldId, optionRenames)) statements.push(D.prepare(s.sql).bind(...s.params))
  // json() of text that is not JSON raises, which rolls the whole batch back.
  const landed = [
    `EXISTS (SELECT 1 FROM custom_field_definitions WHERE id = ? AND slug IS ? AND options IS ? AND updated_at IS ?)`,
    ...rewritten.map(() => `EXISTS (SELECT 1 FROM saved_views WHERE id = ? AND query = ?)`),
  ]
  statements.push(
    D.prepare(`SELECT json('conflict') WHERE NOT (${landed.join(' AND ')})`)
      .bind(fieldId, finalSlug, finalOptions, updates.updatedAt, ...rewritten.flatMap(r => [r.id, r.query])),
  )
  try {
    await D.batch(statements)
  } catch (err) {
    if (/malformed JSON/i.test(String((err as Error)?.message ?? err) + String((err as { cause?: unknown })?.cause ?? ''))) {
      return c.json({ error: 'This field or a saved view changed while it was being renamed. Reload and try again.' }, 409)
    }
    throw err
  }

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
