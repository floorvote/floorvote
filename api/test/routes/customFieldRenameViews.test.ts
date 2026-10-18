import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { getDb } from '../../src/db/client'
import { customFieldDefinitions } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

// Saved views follow a custom field's rename and a dropdown option's rename (#703): the field row and every
// view that filters on it change in one request, or none do.

let adminCookie: string
let memberCookie: string
let adminId: string

async function seedField(opts: { name: string; slug: string; type?: string; options?: string[]; multiple?: boolean }): Promise<string> {
  const id = crypto.randomUUID()
  await getDb(env.DB).insert(customFieldDefinitions).values({
    id,
    name: opts.name,
    slug: opts.slug,
    type: opts.type ?? (opts.options ? 'dropdown' : 'text'),
    options: opts.options ? JSON.stringify(opts.options) : null,
    multiple: opts.multiple ?? false,
    displayOrder: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  return id
}

async function seedView(id: string, query: string, order = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO saved_views (id, name, query, slug, created_by, display_order) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, `View ${id}`, query, `view-${id}`, adminId, order).run()
}

async function viewQuery(id: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT query FROM saved_views WHERE id = ?`).bind(id).first<{ query: string }>()
  return row!.query
}

async function putField(fieldId: string, body: object, cookie = adminCookie): Promise<Response> {
  return app.request(`/api/admin/custom-fields/${fieldId}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
}

async function fieldRow(fieldId: string) {
  return getDb(env.DB).select().from(customFieldDefinitions).where(eq(customFieldDefinitions.id, fieldId)).get()
}

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin' })
  adminCookie = `session=${await seedSession(adminId)}`
  const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member' })
  memberCookie = `session=${await seedSession(memberId)}`
})

describe('renaming a custom field', () => {
  it('rewrites every view that filters on the old slug, in the same request, and leaves a view that does not use it byte-identical', async () => {
    const fieldId = await seedField({ name: 'Fiscal Note', slug: 'fiscal_note' })
    await seedView('a', 'status=introduced&field.fiscal_note=__any__', 0)
    await seedView('b', 'field.fiscal_note=Large&priority=high', 1)
    const untouched = 'priority=high&field.other=x&search=budget'
    await seedView('c', untouched, 2)

    const res = await putField(fieldId, { name: 'Cost Estimate' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, slug: 'cost_estimate' })

    expect(await viewQuery('a')).toBe('status=introduced&field.cost_estimate=__any__')
    expect(await viewQuery('b')).toBe('priority=high&field.cost_estimate=Large')
    expect(await viewQuery('c')).toBe(untouched)
    expect((await fieldRow(fieldId))?.slug).toBe('cost_estimate')
  })

  it('serves the rewritten views from GET /api/views right after the rename', async () => {
    const fieldId = await seedField({ name: 'Fiscal Note', slug: 'fiscal_note' })
    await seedView('a', 'field.fiscal_note=Large')
    await putField(fieldId, { name: 'Cost Estimate' })

    const res = await app.request('/api/views', { headers: { Cookie: memberCookie } }, env)
    const { views } = (await res.json()) as { views: { id: string; query: string }[] }
    expect(views.find(v => v.id === 'a')?.query).toBe('field.cost_estimate=Large')
  })

  it('keeps every value of a multi-select filter, in order, and rewrites several views', async () => {
    const fieldId = await seedField({ name: 'Topics', slug: 'topics', options: ['Roads', 'Water', 'Power'], multiple: true })
    await seedView('a', 'field.topics=Water&field.topics=Roads&field.topics=Power', 0)
    await seedView('b', 'field.topics=__any__&year=2026', 1)
    await seedView('c', 'field.topics=Power&match=any', 2)

    await putField(fieldId, { name: 'Subject Areas' })

    expect(await viewQuery('a')).toBe('field.subject_areas=Water&field.subject_areas=Roads&field.subject_areas=Power')
    expect(await viewQuery('b')).toBe('year=2026&field.subject_areas=__any__')
    expect(await viewQuery('c')).toBe('match=any&field.subject_areas=Power')
  })

  it('rewrites a view that filters on more than one field only for the renamed one', async () => {
    const fieldId = await seedField({ name: 'Region', slug: 'region' })
    await seedField({ name: 'Cost', slug: 'cost' })
    await seedView('a', 'field.cost=High&field.region=North')

    await putField(fieldId, { name: 'Area' })

    expect(await viewQuery('a')).toBe('field.area=North&field.cost=High')
  })

  it('does not rewrite a field whose slug is a prefix or an extension of the renamed one', async () => {
    const shortId = await seedField({ name: 'Reg', slug: 'reg' })
    await seedField({ name: 'Reg Extra', slug: 'reg_extra' })
    await seedView('a', 'field.reg=1&field.reg_extra=2&field.regal=3', 0)
    await seedView('b', 'field.reg_extra=2&field.regal=3', 1)

    await putField(shortId, { name: 'Area' })

    expect(await viewQuery('a')).toBe('field.area=1&field.reg_extra=2&field.regal=3')
    expect(await viewQuery('b')).toBe('field.reg_extra=2&field.regal=3')
  })

  it('rewrites the longer field when the shorter one shares its prefix', async () => {
    await seedField({ name: 'Reg', slug: 'reg' })
    const longId = await seedField({ name: 'Reg Extra', slug: 'reg_extra' })
    await seedView('a', 'field.reg=1&field.reg_extra=2')

    await putField(longId, { name: 'Zone' })

    expect(await viewQuery('a')).toBe('field.reg=1&field.zone=2')
  })

  it('gets a unique slug when the new name collides, and views follow the slug it actually got', async () => {
    await seedField({ name: 'Region', slug: 'region' })
    const zoneId = await seedField({ name: 'Zone', slug: 'zone' })
    await seedView('a', 'field.zone=North&field.region=South')

    const res = await putField(zoneId, { name: 'Region' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, slug: 'region_2' })

    // The view keeps its filter on the other field named region, and the zone filter moves to region_2.
    expect(await viewQuery('a')).toBe('field.region=South&field.region_2=North')
  })

  it('changes no view when only the case of the name changes', async () => {
    const fieldId = await seedField({ name: 'fiscal note', slug: 'fiscal_note' })
    const query = 'priority=high&field.fiscal_note=Large'
    await seedView('a', query)

    const res = await putField(fieldId, { name: 'Fiscal Note' })
    expect(res.status).toBe(200)

    expect(await res.json()).toEqual({ ok: true, slug: 'fiscal_note' })
    expect(await viewQuery('a')).toBe(query)
    expect((await fieldRow(fieldId))?.name).toBe('Fiscal Note')
  })

  it('changes no view when the new name gives the same slug', async () => {
    const fieldId = await seedField({ name: 'Fiscal Note', slug: 'fiscal_note' })
    const query = 'field.fiscal_note=Large'
    await seedView('a', query)

    await putField(fieldId, { name: 'Fiscal-Note!' })

    expect(await viewQuery('a')).toBe(query)
  })

  it('merges into a filter already on the new key without repeating a value', async () => {
    // A stale filter on a deleted field can already use the slug the renamed field now gets.
    const fieldId = await seedField({ name: 'Zone', slug: 'zone', options: ['N', 'S'], multiple: true })
    await seedView('a', 'field.zone=N&field.area=S&field.area=N')

    await putField(fieldId, { name: 'Area' })

    expect(await viewQuery('a')).toBe('field.area=S&field.area=N')
  })

  it('leaves every view unchanged and the field unrenamed when a view write fails', async () => {
    const fieldId = await seedField({ name: 'Fiscal Note', slug: 'fiscal_note' })
    await seedView('a', 'field.fiscal_note=Large', 0)
    await seedView('b', 'field.fiscal_note=Small', 1)
    await env.DB.exec(
      `CREATE TRIGGER fail_view_b BEFORE UPDATE ON saved_views WHEN OLD.id = 'b' BEGIN SELECT RAISE(ABORT, 'view write failed'); END;`,
    )

    const res = await putField(fieldId, { name: 'Cost Estimate' })
    expect(res.status).toBeGreaterThanOrEqual(500)

    const row = await fieldRow(fieldId)
    expect(row?.name).toBe('Fiscal Note')
    expect(row?.slug).toBe('fiscal_note')
    expect(await viewQuery('a')).toBe('field.fiscal_note=Large')
    expect(await viewQuery('b')).toBe('field.fiscal_note=Small')
  })

  it('refuses a member, and changes nothing', async () => {
    const fieldId = await seedField({ name: 'Fiscal Note', slug: 'fiscal_note' })
    await seedView('a', 'field.fiscal_note=Large')

    const res = await putField(fieldId, { name: 'Cost Estimate' }, memberCookie)
    expect(res.status).toBe(403)

    expect((await fieldRow(fieldId))?.slug).toBe('fiscal_note')
    expect(await viewQuery('a')).toBe('field.fiscal_note=Large')
  })

  it('leaves views alone when a field is only pinned', async () => {
    const fieldId = await seedField({ name: 'Fiscal Note', slug: 'fiscal_note' })
    await seedView('a', 'field.fiscal_note=Large')

    await putField(fieldId, { pinned: true })

    expect(await viewQuery('a')).toBe('field.fiscal_note=Large')
  })

  it('leaves views as they are when a field is deleted', async () => {
    const fieldId = await seedField({ name: 'Fiscal Note', slug: 'fiscal_note' })
    await seedView('a', 'field.fiscal_note=Large')

    const res = await app.request(`/api/admin/custom-fields/${fieldId}`, { method: 'DELETE', headers: { Cookie: adminCookie } }, env)
    expect(res.status).toBe(204)

    expect(await viewQuery('a')).toBe('field.fiscal_note=Large')
  })
})

describe('renaming a dropdown option', () => {
  it('rewrites views that filter on the old value and leaves the other values in the same view alone', async () => {
    const fieldId = await seedField({ name: 'Stage', slug: 'stage_note', options: ['Early', 'Mid', 'Late'], multiple: true })
    await seedView('a', 'field.stage_note=Early&field.stage_note=Late', 0)
    await seedView('b', 'field.stage_note=Mid', 1)
    await seedView('c', 'priority=high&field.stage_note=__any__', 2)

    const res = await putField(fieldId, { options: ['Beginning', 'Mid', 'Late'] })
    expect(res.status).toBe(200)

    expect(await viewQuery('a')).toBe('field.stage_note=Beginning&field.stage_note=Late')
    expect(await viewQuery('b')).toBe('field.stage_note=Mid')
    expect(await viewQuery('c')).toBe('priority=high&field.stage_note=__any__')
  })

  it('does not touch a filter on a different field that uses the same value', async () => {
    const fieldId = await seedField({ name: 'Size', slug: 'size', options: ['Big', 'Small'] })
    await seedField({ name: 'Weight', slug: 'weight', options: ['Big', 'Small'] })
    await seedView('a', 'field.size=Big&field.weight=Big')

    await putField(fieldId, { options: ['Large', 'Small'] })

    expect(await viewQuery('a')).toBe('field.size=Large&field.weight=Big')
  })

  it('writes a new value that needs encoding so it parses back to the same text', async () => {
    const fieldId = await seedField({ name: 'Kind', slug: 'kind', options: ['Plain', 'Other'] })
    await seedView('a', 'field.kind=Plain&field.kind=Other')

    await putField(fieldId, { options: ['R&D / 50% + more=ok', 'Other'] })

    const query = await viewQuery('a')
    expect(query).toBe(`field.kind=${encodeURIComponent('R&D / 50% + more=ok').replace(/%20/g, '+')}&field.kind=Other`)
    expect(new URLSearchParams(query).getAll('field.kind')).toEqual(['R&D / 50% + more=ok', 'Other'])
  })

  it('follows an old value that itself needed encoding', async () => {
    const fieldId = await seedField({ name: 'Kind', slug: 'kind', options: ['A&B', 'C'] })
    await seedView('a', `field.kind=${encodeURIComponent('A&B')}`)

    await putField(fieldId, { options: ['A and B', 'C'] })

    expect(await viewQuery('a')).toBe('field.kind=A+and+B')
  })

  it('follows a rename that changes only the case of a value', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['high', 'low'] })
    await seedView('a', 'field.level=high', 0)
    await seedView('b', 'field.level=low', 1)

    await putField(fieldId, { options: ['High', 'low'] })

    expect(await viewQuery('a')).toBe('field.level=High')
    expect(await viewQuery('b')).toBe('field.level=low')
  })

  it('renames several options in one request', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b', 'c'], multiple: true })
    await seedView('v', 'field.level=a&field.level=b&field.level=c')

    await putField(fieldId, { options: ['x', 'b', 'z'] })

    expect(await viewQuery('v')).toBe('field.level=x&field.level=b&field.level=z')
  })

  it('does not rewrite when options are only reordered', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    const query = 'field.level=a'
    await seedView('v', query)

    await putField(fieldId, { options: ['b', 'a'] })

    expect(await viewQuery('v')).toBe(query)
  })

  it('does not rewrite when an option is added or removed', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b', 'c'] })
    await seedView('v', 'field.level=b')

    await putField(fieldId, { options: ['a', 'c'] })
    expect(await viewQuery('v')).toBe('field.level=b')

    await putField(fieldId, { options: ['a', 'c', 'd'] })
    expect(await viewQuery('v')).toBe('field.level=b')
  })

  it('follows both the field slug and an option when one request renames both', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    await seedView('v', 'field.level=a&field.level=b&priority=low')

    const res = await putField(fieldId, { name: 'Tier', options: ['x', 'b'] })
    expect(await res.json()).toEqual({ ok: true, slug: 'tier' })

    expect(await viewQuery('v')).toBe('priority=low&field.tier=x&field.tier=b')
  })

  it('leaves every view unchanged and the options as they were when a view write fails', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    await seedView('v', 'field.level=a')
    await env.DB.exec(
      `CREATE TRIGGER fail_view BEFORE UPDATE ON saved_views BEGIN SELECT RAISE(ABORT, 'view write failed'); END;`,
    )

    const res = await putField(fieldId, { options: ['x', 'b'] })
    expect(res.status).toBeGreaterThanOrEqual(500)

    expect((await fieldRow(fieldId))?.options).toBe(JSON.stringify(['a', 'b']))
    expect(await viewQuery('v')).toBe('field.level=a')
  })
})
