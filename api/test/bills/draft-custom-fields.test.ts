import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, appFetch, stubFetch, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, billCustomFieldValues, customFieldDefinitions, feedEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

// Custom fields at draft creation: POST /bills/draft accepts an optional
// `customFields` map of field ID -> value, in the same value format as
// PUT /bills/:id/custom-fields, validated by the same rules. The draft row and
// its values are written together or not at all.

let adminId: string
let adminToken: string
let memberToken: string

const F = {
  text: 'f-text',
  date: 'f-date',
  binary: 'f-binary',
  single: 'f-single',
  multi: 'f-multi',
}

async function seedFields() {
  await getDb(env.DB).insert(customFieldDefinitions).values([
    { id: F.text, name: 'Notes field', type: 'text', displayOrder: 0 },
    { id: F.date, name: 'Due date', type: 'date', displayOrder: 1 },
    { id: F.binary, name: 'Reviewed', type: 'binary', displayOrder: 2 },
    { id: F.single, name: 'Topic', type: 'dropdown', options: JSON.stringify(['Category A', 'Category B']), multiple: false, displayOrder: 3 },
    { id: F.multi, name: 'Tags', type: 'dropdown', options: JSON.stringify(['Tag A', 'Tag B', 'Tag C']), multiple: true, displayOrder: 4 },
  ])
}

beforeEach(async () => {
  stubFetch() // central lookups and background backfills are answered, never real
  await resetDb()
  await applyMigrations()
  adminId = await seedUser({ email: 'admin@x.com', role: 'admin', name: 'Admin Person' })
  adminToken = await seedSession(adminId)
  const memberId = await seedUser({ email: 'member@x.com', role: 'member' })
  memberToken = await seedSession(memberId)
})

function post(body: unknown, token = adminToken) {
  return appFetch('https://x/api/bills/draft', {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function put(billId: string, body: unknown, token = adminToken) {
  return appFetch(`https://x/api/bills/${billId}/custom-fields`, {
    method: 'PUT',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function create(customFields: unknown, extra: Record<string, unknown> = {}) {
  const res = await post({ billNumber: 'D1', state: 'UT', ...extra, customFields })
  return res
}

async function valuesFor(billId: string) {
  return getDb(env.DB).select().from(billCustomFieldValues).where(eq(billCustomFieldValues.billId, billId)).all()
}

async function allDrafts() {
  return getDb(env.DB).select().from(bills).where(eq(bills.isDraft, true)).all()
}

async function allValues() {
  return getDb(env.DB).select().from(billCustomFieldValues).all()
}

async function allFeedEvents() {
  return getDb(env.DB).select().from(feedEvents).all()
}

async function expectNothingWritten() {
  expect(await allDrafts()).toHaveLength(0)
  expect(await allValues()).toHaveLength(0)
  expect(await allFeedEvents()).toHaveLength(0)
}

describe('POST /api/bills/draft — custom fields, each type', () => {
  beforeEach(seedFields)

  it('stores a text value', async () => {
    const res = await create({ [F.text]: '<p>Some notes</p>' })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    const vals = await valuesFor(id)
    expect(vals).toHaveLength(1)
    expect(vals[0]).toMatchObject({ fieldId: F.text, value: '<p>Some notes</p>' })
  })

  it('stores a date value', async () => {
    const res = await create({ [F.date]: '2027-01-15' })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    expect(await valuesFor(id)).toEqual([expect.objectContaining({ fieldId: F.date, value: '2027-01-15' })])
  })

  it('stores a checked yes/no value as "1"', async () => {
    const res = await create({ [F.binary]: '1' })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    expect(await valuesFor(id)).toEqual([expect.objectContaining({ fieldId: F.binary, value: '1' })])
  })

  it('stores a single-select dropdown value', async () => {
    const res = await create({ [F.single]: 'Category B' })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    expect(await valuesFor(id)).toEqual([expect.objectContaining({ fieldId: F.single, value: 'Category B' })])
  })

  it('stores a multi-select dropdown value as a JSON array, in the order given', async () => {
    const res = await create({ [F.multi]: ['Tag C', 'Tag A'] })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    expect(await valuesFor(id)).toEqual([expect.objectContaining({ fieldId: F.multi, value: JSON.stringify(['Tag C', 'Tag A']) })])
  })

  it('stores a multi-select dropdown with a single value', async () => {
    const res = await create({ [F.multi]: ['Tag B'] })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    expect(await valuesFor(id)).toEqual([expect.objectContaining({ fieldId: F.multi, value: JSON.stringify(['Tag B']) })])
  })

  it('stores every field type in one request', async () => {
    const res = await create({
      [F.text]: '<p>Some notes</p>',
      [F.date]: '2027-01-15',
      [F.binary]: '1',
      [F.single]: 'Category A',
      [F.multi]: ['Tag A', 'Tag B'],
    })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    const byField = Object.fromEntries((await valuesFor(id)).map(v => [v.fieldId, v.value]))
    expect(byField).toEqual({
      [F.text]: '<p>Some notes</p>',
      [F.date]: '2027-01-15',
      [F.binary]: '1',
      [F.single]: 'Category A',
      [F.multi]: JSON.stringify(['Tag A', 'Tag B']),
    })
  })

  it('still creates the draft itself as before', async () => {
    const res = await create({ [F.single]: 'Category A' }, { title: 'A draft' })
    expect(res.status).toBe(201)
    const body = await res.json<{ id: string; billNumber: string; title: string; isDraft: boolean }>()
    expect(body).toMatchObject({ billNumber: 'D1', title: 'A draft', isDraft: true })
    const drafts = await allDrafts()
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ id: body.id, billNumber: 'D1', title: 'A draft', state: 'UT', addedBy: adminId })
    const events = await allFeedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'bill_added', billId: body.id, userId: adminId })
  })
})

describe('POST /api/bills/draft — custom fields, stamping', () => {
  beforeEach(seedFields)

  it('stamps every value with the creating admin as set_by and the creation time', async () => {
    const before = Date.now()
    const res = await create({ [F.text]: 'x', [F.single]: 'Category A', [F.multi]: ['Tag A'] })
    const after = Date.now()
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    const draft = (await allDrafts())[0]
    const vals = await valuesFor(id)
    expect(vals).toHaveLength(3)
    for (const v of vals) {
      expect(v.setBy).toBe(adminId)
      expect(v.updatedAt).toBe(draft.createdAt)
      // datetime('now') format: UTC, space-separated, second precision.
      expect(v.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      const t = Date.parse(v.updatedAt.replace(' ', 'T') + 'Z')
      expect(t).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000)
      expect(t).toBeLessThanOrEqual(after)
    }
  })

  it("shows the values on the draft's bill page right away, set by the creating admin", async () => {
    const res = await create({ [F.date]: '2027-01-15', [F.multi]: ['Tag A', 'Tag C'] })
    const { id } = await res.json<{ id: string }>()
    const detail = await appFetch(`https://x/api/bills/${id}`, { headers: { Cookie: `session=${adminToken}` } })
    expect(detail.status).toBe(200)
    const body = await detail.json<{ customFieldValues: Record<string, { value: string; setBy: string; updatedAt: string }> }>()
    expect(Object.keys(body.customFieldValues).sort()).toEqual([F.date, F.multi].sort())
    expect(body.customFieldValues[F.date]).toMatchObject({ value: '2027-01-15', setBy: 'Admin Person' })
    expect(body.customFieldValues[F.multi]).toMatchObject({ value: JSON.stringify(['Tag A', 'Tag C']), setBy: 'Admin Person' })
  })

  it('shows the values to a member viewing the draft, too', async () => {
    const res = await create({ [F.single]: 'Category B' })
    const { id } = await res.json<{ id: string }>()
    const detail = await appFetch(`https://x/api/bills/${id}`, { headers: { Cookie: `session=${memberToken}` } })
    expect(detail.status).toBe(200)
    const body = await detail.json<{ customFieldValues: Record<string, { value: string }> }>()
    expect(body.customFieldValues[F.single]).toMatchObject({ value: 'Category B' })
  })
})

describe('POST /api/bills/draft — custom fields are optional', () => {
  it('creates a draft with no custom fields defined and none sent', async () => {
    const res = await post({ billNumber: 'D1', state: 'UT' })
    expect(res.status).toBe(201)
    expect(await allDrafts()).toHaveLength(1)
    expect(await allValues()).toHaveLength(0)
  })

  it('creates a draft with no custom fields defined and an empty map sent', async () => {
    const res = await create({})
    expect(res.status).toBe(201)
    expect(await allDrafts()).toHaveLength(1)
    expect(await allValues()).toHaveLength(0)
  })

  it('creates a draft when customFields is null', async () => {
    const res = await create(null)
    expect(res.status).toBe(201)
    expect(await allDrafts()).toHaveLength(1)
    expect(await allValues()).toHaveLength(0)
  })

  it('creates a draft with fields defined but none sent', async () => {
    await seedFields()
    const res = await post({ billNumber: 'D1', state: 'UT' })
    expect(res.status).toBe(201)
    expect(await allDrafts()).toHaveLength(1)
    expect(await allValues()).toHaveLength(0)
  })

  it('treats null values and an empty multi-select as "not set": the draft is created and no row is written for them', async () => {
    await seedFields()
    const res = await create({
      [F.text]: null, [F.date]: null, [F.binary]: null, [F.single]: null, [F.multi]: [],
    })
    expect(res.status).toBe(201)
    expect(await allDrafts()).toHaveLength(1)
    expect(await allValues()).toHaveLength(0)
  })

  it('writes only the set values when some are null', async () => {
    await seedFields()
    const res = await create({ [F.text]: null, [F.single]: 'Category A' })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    expect((await valuesFor(id)).map(v => v.fieldId)).toEqual([F.single])
  })
})

// Each case is invalid under the shared rules. They run against BOTH endpoints:
// the create-draft endpoint (nothing written) and the bill page's
// PUT /bills/:id/custom-fields (no value written), so the two cannot drift.
const INVALID: [label: string, body: () => Record<string, unknown>][] = [
  ['an unknown field id', () => ({ 'no-such-field': 'x' })],
  ['a known field alongside an unknown one', () => ({ [F.single]: 'Category A', 'no-such-field': 'x' })],
  ['a single-select dropdown value not among its options', () => ({ [F.single]: 'Category Z' })],
  ['multiple values on a single-select dropdown', () => ({ [F.single]: ['Category A', 'Category B'] })],
  ['a one-element array on a single-select dropdown', () => ({ [F.single]: ['Category A'] })],
  ['a multi-select value not among its options', () => ({ [F.multi]: ['Tag A', 'Tag Z'] })],
  ['a bare string on a multi-select dropdown', () => ({ [F.multi]: 'Tag A' })],
  ['a non-string element in a multi-select array', () => ({ [F.multi]: ['Tag A', 7] })],
  ['an array on a text field', () => ({ [F.text]: ['a', 'b'] })],
  ['a number on a text field', () => ({ [F.text]: 42 })],
  ['a boolean on a yes/no field', () => ({ [F.binary]: true })],
  ['"yes" on a yes/no field', () => ({ [F.binary]: 'yes' })],
  ['"0" on a yes/no field', () => ({ [F.binary]: '0' })],
  ['an object on a date field', () => ({ [F.date]: { y: 2027 } })],
  ['a non-date string on a date field', () => ({ [F.date]: 'next week' })],
  ['an impossible calendar date', () => ({ [F.date]: '2027-02-30' })],
  ['a date in the wrong format', () => ({ [F.date]: '01/15/2027' })],
  ['a datetime on a date field', () => ({ [F.date]: '2027-01-15T10:00:00Z' })],
  ['an empty string on a date field', () => ({ [F.date]: '' })],
  ['an empty string on a single-select dropdown', () => ({ [F.single]: '' })],
  ['several valid values and one invalid', () => ({
    [F.text]: 'ok', [F.date]: '2027-01-15', [F.binary]: '1', [F.multi]: ['Tag A'], [F.single]: 'Category Z',
  })],
]

describe('POST /api/bills/draft — invalid custom field values write nothing', () => {
  beforeEach(seedFields)

  it.each(INVALID)('rejects %s with 400 and writes no draft and no values', async (_label, body) => {
    const res = await create(body())
    expect(res.status).toBe(400)
    const err = await res.json<{ error: string }>()
    expect(typeof err.error).toBe('string')
    await expectNothingWritten()
  })

  it('names the unknown field in the error', async () => {
    const res = await create({ 'no-such-field': 'x' })
    expect(await res.json()).toMatchObject({ error: 'unknown field: no-such-field' })
  })

  it('reports which dropdown values were not among the options', async () => {
    const res = await create({ [F.multi]: ['Tag A', 'Tag Z', 'Tag Y'] })
    expect(await res.json()).toMatchObject({ error: 'invalid_options', fieldId: F.multi, invalid: ['Tag Z', 'Tag Y'] })
  })

  it('reports a single-select value not among the options the same way', async () => {
    const res = await create({ [F.single]: 'Category Z' })
    expect(await res.json()).toMatchObject({ error: 'invalid_options', fieldId: F.single, invalid: ['Category Z'] })
  })

  it('rejects a value for a field that no longer exists, writing nothing', async () => {
    await getDb(env.DB).delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, F.single))
    const res = await create({ [F.single]: 'Category A' })
    expect(res.status).toBe(400)
    await expectNothingWritten()
  })

  it('leaves the draft number free, so the corrected request succeeds without a duplicate', async () => {
    const bad = await create({ [F.single]: 'Category Z' })
    expect(bad.status).toBe(400)
    const good = await create({ [F.single]: 'Category A' })
    expect(good.status).toBe(201)
    expect(await allDrafts()).toHaveLength(1)
    expect(await allValues()).toHaveLength(1)
  })
})

describe('POST /api/bills/draft — malformed customFields write nothing', () => {
  beforeEach(seedFields)

  it.each([
    ['an array', [F.text]],
    ['a string', 'Category A'],
    ['a number', 7],
    ['a boolean', true],
  ])('rejects customFields given as %s', async (_label, customFields) => {
    const res = await create(customFields)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'customFields must be an object of field ID to value' })
    await expectNothingWritten()
  })

  it('does not let a member create a draft with custom fields', async () => {
    const res = await post({ billNumber: 'D1', state: 'UT', customFields: { [F.single]: 'Category A' } }, memberToken)
    expect(res.status).toBe(403)
    await expectNothingWritten()
  })

  it('writes no values when the number collides', async () => {
    await seedBill({ billNumber: 'D1', state: 'UT', yearStart: 2026, yearEnd: 2026 })
    const res = await create({ [F.single]: 'Category A' }, { year: 2026 })
    expect(res.status).toBe(409)
    expect(await allDrafts()).toHaveLength(0)
    expect(await allValues()).toHaveLength(0)
  })
})

describe('PUT /api/bills/:id/custom-fields — the same rules as at creation', () => {
  let billId: string
  beforeEach(async () => {
    await seedFields()
    billId = await seedBill()
  })

  it.each(INVALID)('rejects %s with 400 and writes no value', async (_label, body) => {
    const res = await put(billId, body())
    expect(res.status).toBe(400)
    expect(await allValues()).toHaveLength(0)
  })

  it('still accepts a valid value of every type', async () => {
    const res = await put(billId, {
      [F.text]: '<p>Some notes</p>',
      [F.date]: '2027-01-15',
      [F.binary]: '1',
      [F.single]: 'Category A',
      [F.multi]: ['Tag A', 'Tag B'],
    })
    expect(res.status).toBe(200)
    expect(await valuesFor(billId)).toHaveLength(5)
  })

  it('still clears a value with null and a multi-select with an empty array', async () => {
    await put(billId, { [F.single]: 'Category A', [F.multi]: ['Tag A'] })
    const res = await put(billId, { [F.single]: null, [F.multi]: [] })
    expect(res.status).toBe(200)
    expect(await valuesFor(billId)).toHaveLength(0)
  })
})

describe('custom fields set at creation carry over on link', () => {
  beforeEach(seedFields)

  it('moves values set at creation onto the filed bill, keeping set_by and updated_at', async () => {
    const filedId = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:111' })
    const res = await create({ [F.single]: 'Category A', [F.multi]: ['Tag A', 'Tag B'], [F.binary]: '1' })
    expect(res.status).toBe(201)
    const { id: draftId } = await res.json<{ id: string }>()
    const before = Object.fromEntries((await valuesFor(draftId)).map(v => [v.fieldId, v]))

    const link = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(link.status).toBe(200)

    const after = await valuesFor(filedId)
    expect(after).toHaveLength(3)
    for (const v of after) {
      expect(v).toMatchObject({
        value: before[v.fieldId].value,
        setBy: adminId,
        updatedAt: before[v.fieldId].updatedAt,
      })
    }
    expect(await valuesFor(draftId)).toHaveLength(0)
  })
})
