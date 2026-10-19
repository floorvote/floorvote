import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { getDb } from '../../src/db/client'
import { customFieldDefinitions, billCustomFieldValues } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'

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
  await clearDb()
  adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin' })
  adminCookie = `session=${await seedSession(adminId)}`
  const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member' })
  memberCookie = `session=${await seedSession(memberId)}`
})

// The write-failure tests below install a trigger that aborts updates to
// saved_views. Drop it afterwards: clearDb() empties users, whose ON DELETE
// SET NULL on saved_views.created_by is an update, and would trip it.
afterEach(async () => {
  await env.DB.exec('DROP TRIGGER IF EXISTS fail_view; DROP TRIGGER IF EXISTS fail_view_b;')
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

    const res = await putField(fieldId, { options: ['Beginning', 'Mid', 'Late'], renames: [{ from: 'Early', to: 'Beginning' }] })
    expect(res.status).toBe(200)

    expect(await viewQuery('a')).toBe('field.stage_note=Beginning&field.stage_note=Late')
    expect(await viewQuery('b')).toBe('field.stage_note=Mid')
    expect(await viewQuery('c')).toBe('priority=high&field.stage_note=__any__')
  })

  it('does not touch a filter on a different field that uses the same value', async () => {
    const fieldId = await seedField({ name: 'Size', slug: 'size', options: ['Big', 'Small'] })
    await seedField({ name: 'Weight', slug: 'weight', options: ['Big', 'Small'] })
    await seedView('a', 'field.size=Big&field.weight=Big')

    await putField(fieldId, { options: ['Large', 'Small'], renames: [{ from: 'Big', to: 'Large' }] })

    expect(await viewQuery('a')).toBe('field.size=Large&field.weight=Big')
  })

  it('writes a new value that needs encoding so it parses back to the same text', async () => {
    const fieldId = await seedField({ name: 'Kind', slug: 'kind', options: ['Plain', 'Other'] })
    await seedView('a', 'field.kind=Plain&field.kind=Other')

    await putField(fieldId, { options: ['R&D / 50% + more=ok', 'Other'], renames: [{ from: 'Plain', to: 'R&D / 50% + more=ok' }] })

    const query = await viewQuery('a')
    expect(query).toBe(`field.kind=${encodeURIComponent('R&D / 50% + more=ok').replace(/%20/g, '+')}&field.kind=Other`)
    expect(new URLSearchParams(query).getAll('field.kind')).toEqual(['R&D / 50% + more=ok', 'Other'])
  })

  it('follows an old value that itself needed encoding', async () => {
    const fieldId = await seedField({ name: 'Kind', slug: 'kind', options: ['A&B', 'C'] })
    await seedView('a', `field.kind=${encodeURIComponent('A&B')}`)

    await putField(fieldId, { options: ['A and B', 'C'], renames: [{ from: 'A&B', to: 'A and B' }] })

    expect(await viewQuery('a')).toBe('field.kind=A+and+B')
  })

  it('follows a rename that changes only the case of a value', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['high', 'low'] })
    await seedView('a', 'field.level=high', 0)
    await seedView('b', 'field.level=low', 1)

    await putField(fieldId, { options: ['High', 'low'], renames: [{ from: 'high', to: 'High' }] })

    expect(await viewQuery('a')).toBe('field.level=High')
    expect(await viewQuery('b')).toBe('field.level=low')
  })

  it('renames several options in one request', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b', 'c'], multiple: true })
    await seedView('v', 'field.level=a&field.level=b&field.level=c')

    await putField(fieldId, { options: ['x', 'b', 'z'], renames: [{ from: 'a', to: 'x' }, { from: 'c', to: 'z' }] })

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

    const res = await putField(fieldId, { name: 'Tier', options: ['x', 'b'], renames: [{ from: 'a', to: 'x' }] })
    expect(await res.json()).toEqual({ ok: true, slug: 'tier' })

    expect(await viewQuery('v')).toBe('priority=low&field.tier=x&field.tier=b')
  })

  it('leaves every view unchanged and the options as they were when a view write fails', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    await seedView('v', 'field.level=a')
    await env.DB.exec(
      `CREATE TRIGGER fail_view BEFORE UPDATE ON saved_views BEGIN SELECT RAISE(ABORT, 'view write failed'); END;`,
    )

    const res = await putField(fieldId, { options: ['x', 'b'], renames: [{ from: 'a', to: 'x' }] })
    expect(res.status).toBeGreaterThanOrEqual(500)

    expect((await fieldRow(fieldId))?.options).toBe(JSON.stringify(['a', 'b']))
    expect(await viewQuery('v')).toBe('field.level=a')
  })
})

describe('the options rename is explicit', () => {
  it('follows a rename saved together with an added option', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'], multiple: true })
    await seedView('v', 'field.level=a&field.level=b')

    const res = await putField(fieldId, { options: ['x', 'b', 'c'], renames: [{ from: 'a', to: 'x' }] })
    expect(res.status).toBe(200)

    expect(await viewQuery('v')).toBe('field.level=x&field.level=b')
    expect((await fieldRow(fieldId))?.options).toBe(JSON.stringify(['x', 'b', 'c']))
  })

  it('follows a rename saved together with a deleted option', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b', 'c'], multiple: true })
    await seedView('v', 'field.level=a&field.level=c')

    await putField(fieldId, { options: ['x', 'c'], renames: [{ from: 'a', to: 'x' }] })

    expect(await viewQuery('v')).toBe('field.level=x&field.level=c')
  })

  it('rewrites nothing when one option is deleted and another added in the same save', async () => {
    const fieldId = await seedField({ name: 'Status', slug: 'review', options: ['Pending', 'Done'] })
    const query = 'field.review=Pending'
    await seedView('v', query)

    const res = await putField(fieldId, { options: ['Withdrawn', 'Done'] })
    expect(res.status).toBe(200)

    expect(await viewQuery('v')).toBe(query)
    expect((await fieldRow(fieldId))?.options).toBe(JSON.stringify(['Withdrawn', 'Done']))
  })

  it('follows a rename that also moves the option to a new position', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b', 'c'] })
    await seedView('v', 'field.level=a')

    await putField(fieldId, { options: ['b', 'c', 'x'], renames: [{ from: 'a', to: 'x' }] })

    expect(await viewQuery('v')).toBe('field.level=x')
  })

  it('swaps two options by rename in one write per view', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['A', 'B'], multiple: true })
    await seedView('v1', 'field.level=A', 0)
    await seedView('v2', 'field.level=B&field.level=A', 1)

    const res = await putField(fieldId, { options: ['B', 'A'], renames: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }] })
    expect(res.status).toBe(200)

    expect(await viewQuery('v1')).toBe('field.level=B')
    expect(await viewQuery('v2')).toBe('field.level=A&field.level=B')
  })

  it('ignores a rename on a view that does not filter on the field', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    const query = 'priority=a&field.other=a'
    await seedView('v', query)

    await putField(fieldId, { options: ['x', 'b'], renames: [{ from: 'a', to: 'x' }] })

    expect(await viewQuery('v')).toBe(query)
  })

  const invalid: [string, unknown][] = [
    ['a from that was not in the old options', [{ from: 'zzz', to: 'x' }]],
    ['a to that is not in the new options', [{ from: 'a', to: 'nope' }]],
    ['a from listed twice', [{ from: 'a', to: 'x' }, { from: 'a', to: 'b' }]],
    ['a to listed twice', [{ from: 'a', to: 'x' }, { from: 'b', to: 'x' }]],
    ['a chain', [{ from: 'a', to: 'x' }, { from: 'x', to: 'b' }]],
    ['a rename to itself', [{ from: 'b', to: 'b' }]],
    ['an entry that is not an object', ['a']],
    ['an entry with a non-string value', [{ from: 1, to: 'x' }]],
    ['renames that is not an array', { from: 'a', to: 'x' }],
  ]
  for (const [label, renames] of invalid) {
    it(`refuses ${label} with 400 and changes nothing`, async () => {
      const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b', 'x'] })
      await seedView('v', 'field.level=a')

      const res = await putField(fieldId, { name: 'Tier', options: ['x', 'b', 'x2', 'a2'], renames })
      // 'x' stays in the new list so the chain case is checked against valid targets.
      expect(res.status).toBe(400)

      const row = await fieldRow(fieldId)
      expect(row?.name).toBe('Level')
      expect(row?.slug).toBe('level')
      expect(row?.options).toBe(JSON.stringify(['a', 'b', 'x']))
      expect(await viewQuery('v')).toBe('field.level=a')
    })
  }

  it('refuses renames sent without options', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    const res = await putField(fieldId, { renames: [{ from: 'a', to: 'b' }] })
    expect(res.status).toBe(400)
  })

  it('refuses renames on a field that is not a dropdown', async () => {
    const fieldId = await seedField({ name: 'Note', slug: 'note' })
    const res = await putField(fieldId, { options: ['a'], renames: [{ from: 'a', to: 'a' }] })
    expect(res.status).toBe(400)
  })
})

describe('a rename keeps the rest of the view', () => {
  it('keeps sort, dir, and an unknown key after a field rename', async () => {
    const fieldId = await seedField({ name: 'Region', slug: 'region' })
    await seedView('v', 'dir=asc&field.region=North&sort=title&status=introduced&keep=1&keep=2')

    await putField(fieldId, { name: 'Zone' })

    const params = new URLSearchParams(await viewQuery('v'))
    expect(params.getAll('field.zone')).toEqual(['North'])
    expect(params.getAll('status')).toEqual(['introduced'])
    expect(params.get('sort')).toBe('title')
    expect(params.get('dir')).toBe('asc')
    expect(params.getAll('keep')).toEqual(['1', '2'])
  })

  it('keeps sort and dir after an option rename', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    await seedView('v', 'sort=title&dir=desc&field.level=a')

    await putField(fieldId, { options: ['x', 'b'], renames: [{ from: 'a', to: 'x' }] })

    const params = new URLSearchParams(await viewQuery('v'))
    expect(params.getAll('field.level')).toEqual(['x'])
    expect(params.get('sort')).toBe('title')
    expect(params.get('dir')).toBe('desc')
  })
})

describe('an option rename keeps the bills a view selects', () => {
  async function seedValue(billId: string, fieldId: string, value: string) {
    await getDb(env.DB).insert(billCustomFieldValues).values({ billId, fieldId, value, setBy: adminId })
  }
  async function storedValue(billId: string, fieldId: string): Promise<string | undefined> {
    return (await getDb(env.DB).select().from(billCustomFieldValues).where(eq(billCustomFieldValues.billId, billId)).all())
      .find(r => r.fieldId === fieldId)?.value
  }
  async function billsFor(query: string): Promise<string[]> {
    const res = await app.request(`/api/bills?${query}&pageSize=50`, { headers: { Cookie: adminCookie } }, env)
    const body = (await res.json()) as { bills: { id: string }[] }
    return body.bills.map(b => b.id).sort()
  }

  it('selects the same bills after a single-select option is renamed', async () => {
    const fieldId = await seedField({ name: 'Stage', slug: 'stage', options: ['Early', 'Late'] })
    const b1 = await seedBill({ billNumber: 'B1' })
    const b2 = await seedBill({ billNumber: 'B2' })
    const b3 = await seedBill({ billNumber: 'B3' })
    await seedValue(b1, fieldId, 'Early')
    await seedValue(b2, fieldId, 'Late')
    await seedValue(b3, fieldId, 'Early')
    await seedView('v', 'field.stage=Early')
    const before = await billsFor(await viewQuery('v'))
    expect(before).toEqual([b1, b3].sort())

    await putField(fieldId, { options: ['Beginning', 'Late'], renames: [{ from: 'Early', to: 'Beginning' }] })

    expect(await viewQuery('v')).toBe('field.stage=Beginning')
    expect(await billsFor(await viewQuery('v'))).toEqual(before)
    expect(await storedValue(b2, fieldId)).toBe('Late')
  })

  it('selects the same bills after a multi-select option is renamed, keeping the bill\'s other values and order', async () => {
    const fieldId = await seedField({ name: 'Areas', slug: 'areas', options: ['a', 'b', 'c'], multiple: true })
    const b1 = await seedBill({ billNumber: 'B1' })
    const b2 = await seedBill({ billNumber: 'B2' })
    const b3 = await seedBill({ billNumber: 'B3' })
    await seedValue(b1, fieldId, JSON.stringify(['c', 'a', 'b']))
    await seedValue(b2, fieldId, JSON.stringify(['b']))
    await seedValue(b3, fieldId, 'a')
    await seedView('v', 'field.areas=a')
    // A bare string in a multi-select field is a legacy value the list does not match, so the view selects only b1.
    const before = await billsFor(await viewQuery('v'))
    expect(before).toEqual([b1])

    await putField(fieldId, { options: ['x', 'b', 'c'], renames: [{ from: 'a', to: 'x' }] })
    expect(await storedValue(b3, fieldId)).toBe('x')

    expect(await billsFor(await viewQuery('v'))).toEqual(before)
    expect(await storedValue(b1, fieldId)).toBe(JSON.stringify(['c', 'x', 'b']))
    expect(await storedValue(b2, fieldId)).toBe(JSON.stringify(['b']))
  })

  it('selects the same bills after two options are swapped', async () => {
    const fieldId = await seedField({ name: 'Areas', slug: 'areas', options: ['A', 'B'], multiple: true })
    const b1 = await seedBill({ billNumber: 'B1' })
    const b2 = await seedBill({ billNumber: 'B2' })
    await seedValue(b1, fieldId, JSON.stringify(['A']))
    await seedValue(b2, fieldId, JSON.stringify(['B']))
    await seedView('va', 'field.areas=A')
    const before = await billsFor('field.areas=A')

    await putField(fieldId, { options: ['B', 'A'], renames: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }] })

    expect(await viewQuery('va')).toBe('field.areas=B')
    expect(await billsFor(await viewQuery('va'))).toEqual(before)
    expect(await storedValue(b1, fieldId)).toBe(JSON.stringify(['B']))
    expect(await storedValue(b2, fieldId)).toBe(JSON.stringify(['A']))
  })

  it('selects the same bills when a rename is saved with an added option', async () => {
    const fieldId = await seedField({ name: 'Stage', slug: 'stage', options: ['Early', 'Late'] })
    const b1 = await seedBill({ billNumber: 'B1' })
    await seedValue(b1, fieldId, 'Early')
    await seedView('v', 'field.stage=Early')

    await putField(fieldId, { options: ['Beginning', 'Late', 'Never'], renames: [{ from: 'Early', to: 'Beginning' }] })

    expect(await billsFor(await viewQuery('v'))).toEqual([b1])
  })

  it('leaves a bill that holds the same text in another field, and a bill holding no value, alone', async () => {
    const fieldId = await seedField({ name: 'Size', slug: 'size', options: ['Big', 'Small'] })
    const otherId = await seedField({ name: 'Weight', slug: 'weight', options: ['Big', 'Small'] })
    const b1 = await seedBill({ billNumber: 'B1' })
    const b2 = await seedBill({ billNumber: 'B2' })
    await seedValue(b1, otherId, 'Big')
    await seedValue(b2, fieldId, 'Big')

    await putField(fieldId, { options: ['Large', 'Small'], renames: [{ from: 'Big', to: 'Large' }] })

    expect(await storedValue(b1, otherId)).toBe('Big')
    expect(await storedValue(b2, fieldId)).toBe('Large')
  })

  it('merges a bill\'s values when an option is renamed into another it already holds', async () => {
    const fieldId = await seedField({ name: 'Areas', slug: 'areas', options: ['a', 'b'], multiple: true })
    const b1 = await seedBill({ billNumber: 'B1' })
    await seedValue(b1, fieldId, JSON.stringify(['a', 'b']))

    await putField(fieldId, { options: ['b', 'b2'], renames: [{ from: 'a', to: 'b' }] })

    expect(await storedValue(b1, fieldId)).toBe(JSON.stringify(['b']))
  })

  it('does not rewrite bill values when the options only change by add, delete, or reorder', async () => {
    const fieldId = await seedField({ name: 'Stage', slug: 'stage', options: ['Early', 'Late'] })
    const b1 = await seedBill({ billNumber: 'B1' })
    await seedValue(b1, fieldId, 'Early')

    await putField(fieldId, { options: ['Late', 'Early', 'Never'] })

    expect(await storedValue(b1, fieldId)).toBe('Early')
  })

  it('leaves bill values as they were when a view write fails', async () => {
    const fieldId = await seedField({ name: 'Stage', slug: 'stage', options: ['Early', 'Late'] })
    const b1 = await seedBill({ billNumber: 'B1' })
    await seedValue(b1, fieldId, 'Early')
    await seedView('v', 'field.stage=Early')
    await env.DB.exec(`CREATE TRIGGER fail_view BEFORE UPDATE ON saved_views BEGIN SELECT RAISE(ABORT, 'view write failed'); END;`)

    const res = await putField(fieldId, { options: ['Beginning', 'Late'], renames: [{ from: 'Early', to: 'Beginning' }] })
    expect(res.status).toBeGreaterThanOrEqual(500)

    expect(await storedValue(b1, fieldId)).toBe('Early')
  })
})

describe('a rename does not overwrite a concurrent change', () => {
  /** Runs `during` after the handler has read its views and before it writes them. */
  function withInterloper(during: () => Promise<void>) {
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await during()
            return target.batch(statements)
          }
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    return { ...env, DB: db } as typeof env
  }

  async function putWith(bindings: typeof env, fieldId: string, body: object): Promise<Response> {
    return app.request(`/api/admin/custom-fields/${fieldId}`, {
      method: 'PUT',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, bindings)
  }

  it('answers 409 and writes nothing when a view is edited between the read and the write', async () => {
    const fieldId = await seedField({ name: 'Region', slug: 'region' })
    await seedView('a', 'field.region=North', 0)
    await seedView('b', 'field.region=South', 1)
    const edited = 'priority=high&field.region=East'
    const bindings = withInterloper(async () => {
      await env.DB.prepare(`UPDATE saved_views SET query = ? WHERE id = 'a'`).bind(edited).run()
    })

    const res = await putWith(bindings, fieldId, { name: 'Zone' })
    expect(res.status).toBe(409)

    expect(await viewQuery('a')).toBe(edited)
    expect(await viewQuery('b')).toBe('field.region=South')
    const row = await fieldRow(fieldId)
    expect(row?.name).toBe('Region')
    expect(row?.slug).toBe('region')
  })

  it('answers 409 and writes nothing when the field was renamed between the read and the write', async () => {
    const fieldId = await seedField({ name: 'Region', slug: 'region' })
    await seedView('a', 'field.region=North')
    const bindings = withInterloper(async () => {
      await env.DB.prepare(`UPDATE custom_field_definitions SET name = 'Area', slug = 'area' WHERE id = ?`).bind(fieldId).run()
    })

    const res = await putWith(bindings, fieldId, { name: 'Zone' })
    expect(res.status).toBe(409)

    expect((await fieldRow(fieldId))?.slug).toBe('area')
    expect(await viewQuery('a')).toBe('field.region=North')
  })

  it('answers 409 and writes nothing when the options changed between the read and the write', async () => {
    const fieldId = await seedField({ name: 'Level', slug: 'level', options: ['a', 'b'] })
    const b1 = await seedBill({ billNumber: 'B1' })
    await getDb(env.DB).insert(billCustomFieldValues).values({ billId: b1, fieldId, value: 'a', setBy: adminId })
    await seedView('v', 'field.level=a')
    const bindings = withInterloper(async () => {
      await env.DB.prepare(`UPDATE custom_field_definitions SET options = ? WHERE id = ?`).bind(JSON.stringify(['a', 'b', 'c']), fieldId).run()
    })

    const res = await putWith(bindings, fieldId, { options: ['x', 'b'], renames: [{ from: 'a', to: 'x' }] })
    expect(res.status).toBe(409)

    expect((await fieldRow(fieldId))?.options).toBe(JSON.stringify(['a', 'b', 'c']))
    expect(await viewQuery('v')).toBe('field.level=a')
    const stored = await env.DB.prepare(`SELECT value FROM bill_custom_field_values WHERE bill_id = ?`).bind(b1).first<{ value: string }>()
    expect(stored?.value).toBe('a')
  })

  it('does not strand a view on a dead slug when two fields it uses are renamed at once', async () => {
    const aId = await seedField({ name: 'Alpha', slug: 'alpha' })
    const bId = await seedField({ name: 'Beta', slug: 'beta' })
    await seedView('v', 'field.alpha=1&field.beta=2')

    const results = await Promise.all([putField(aId, { name: 'Apple' }), putField(bId, { name: 'Berry' })])
    for (const res of results) expect([200, 409]).toContain(res.status)
    // A refused rename is retried, as the client reloads and tries again.
    if (results[0].status === 409) expect((await putField(aId, { name: 'Apple' })).status).toBe(200)
    if (results[1].status === 409) expect((await putField(bId, { name: 'Berry' })).status).toBe(200)

    expect(await viewQuery('v')).toBe('field.apple=1&field.berry=2')
  })

  it('lets only one of two renames of the same field win, and the views follow the winner', async () => {
    const id = await seedField({ name: 'Alpha', slug: 'alpha' })
    await seedView('v', 'field.alpha=1')

    const results = await Promise.all([putField(id, { name: 'First' }), putField(id, { name: 'Second' })])
    for (const res of results) expect([200, 409]).toContain(res.status)

    const slug = (await fieldRow(id))?.slug as string
    expect(['first', 'second']).toContain(slug)
    expect(await viewQuery('v')).toBe(`field.${slug}=1`)
  })
})
