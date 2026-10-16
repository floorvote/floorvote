import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, appFetch, stubFetch, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, calendarEvents, calendarEventBills, feedEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

// Untitled drafts: a draft bill may be created, and edited, with no title. The
// row stores '' (bills.title stays NOT NULL) and every display surface shows
// "Untitled draft" through the shared billDisplayTitle helper. Filed bills are
// unaffected.

let adminToken: string
let memberToken: string

beforeEach(async () => {
  stubFetch() // central lookups and background backfills are answered, never real
  await resetDb()
  await applyMigrations()
  const adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
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

function patch(id: string, body: unknown, token = adminToken) {
  return appFetch(`https://x/api/bills/${id}/draft`, {
    method: 'PATCH',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function row(id: string) {
  return getDb(env.DB).select().from(bills).where(eq(bills.id, id)).get()
}

describe('POST /api/bills/draft — untitled drafts', () => {
  it('creates a draft with no title field, storing an empty string', async () => {
    const res = await post({ billNumber: 'D1', state: 'UT' })
    expect(res.status).toBe(201)
    const body = await res.json<{ id: string; title: string; billNumber: string; isDraft: boolean }>()
    expect(body.title).toBe('')
    expect(body.billNumber).toBe('D1')
    expect(body.isDraft).toBe(true)

    const r = await row(body.id)
    expect(r?.title).toBe('')
    expect(r?.isDraft).toBe(true)
    expect(r?.billNumber).toBe('D1')
  })

  it.each([
    ['empty', ''],
    ['whitespace-only', '   \t '],
    ['null', null],
  ])('creates a draft with a %s title, storing an empty string', async (_label, title) => {
    const res = await post({ billNumber: 'D1', state: 'UT', title })
    expect(res.status).toBe(201)
    const { id } = await res.json<{ id: string }>()
    expect((await row(id))?.title).toBe('')
  })

  it('still creates a titled draft as before, trimming the title', async () => {
    const res = await post({ billNumber: 'D1', state: 'UT', title: '  Draft bill title  ' })
    expect(res.status).toBe(201)
    const body = await res.json<{ id: string; title: string }>()
    expect(body.title).toBe('Draft bill title')
    expect((await row(body.id))?.title).toBe('Draft bill title')
  })

  it('creates an untitled draft with neither a title nor a number, auto-assigning the number', async () => {
    const res = await post({ state: 'UT' })
    expect(res.status).toBe(201)
    const body = await res.json<{ id: string; billNumber: string; title: string }>()
    expect(body.billNumber).toBe('D1')
    expect(body.title).toBe('')
  })

  it('lets several untitled drafts coexist, told apart by their numbers', async () => {
    const a = await post({ billNumber: 'D1', state: 'UT' })
    const b = await post({ billNumber: 'D2', state: 'UT' })
    const c = await post({ state: 'UT' })
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201])
    const drafts = await getDb(env.DB).select().from(bills).where(eq(bills.isDraft, true)).all()
    expect(drafts.map(d => d.billNumber).sort()).toEqual(['D1', 'D2', 'D3'])
    expect(drafts.every(d => d.title === '')).toBe(true)
  })

  it('records the bill_added feed event for an untitled draft', async () => {
    const res = await post({ billNumber: 'D1', state: 'UT' })
    const { id } = await res.json<{ id: string }>()
    const feed = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.billId, id)).all()
    expect(feed).toHaveLength(1)
    expect(feed[0].type).toBe('bill_added')
  })

  it('still rejects an untitled draft with no resolvable state, and writes nothing', async () => {
    const res = await post({ billNumber: 'D1' })
    expect(res.status).toBe(400)
    const drafts = await getDb(env.DB).select().from(bills).where(eq(bills.isDraft, true)).all()
    expect(drafts).toHaveLength(0)
  })

  it('still 409s an untitled draft whose number collides, and writes nothing', async () => {
    await seedBill({ id: 'filed', billNumber: 'HB0209', title: 'Filed', state: 'UT', yearStart: 2026, yearEnd: 2026 })
    const res = await post({ billNumber: 'HB0209', year: 2026, state: 'UT' })
    expect(res.status).toBe(409)
    const drafts = await getDb(env.DB).select().from(bills).where(eq(bills.isDraft, true)).all()
    expect(drafts).toHaveLength(0)
  })

  it('still rejects a non-admin creating an untitled draft', async () => {
    const res = await post({ billNumber: 'D1', state: 'UT' }, memberToken)
    expect(res.status).toBe(403)
  })

  it('returns the untitled draft from GET /bills/drafts with its raw empty title', async () => {
    await post({ billNumber: 'D1', state: 'UT' })
    const res = await appFetch('https://x/api/bills/drafts', { headers: { Cookie: `session=${adminToken}` } })
    const body = await res.json<{ drafts: Array<{ billNumber: string; title: string }> }>()
    expect(body.drafts).toEqual([expect.objectContaining({ billNumber: 'D1', title: '' })])
  })

  it('returns the untitled draft from GET /bills/:id with its raw empty title and isDraft', async () => {
    const { id } = await (await post({ billNumber: 'D1', state: 'UT' })).json<{ id: string }>()
    const res = await appFetch(`https://x/api/bills/${id}`, { headers: { Cookie: `session=${adminToken}` } })
    expect(res.status).toBe(200)
    const body = await res.json<{ title: string; isDraft: boolean; billNumber: string }>()
    expect(body).toMatchObject({ title: '', isDraft: true, billNumber: 'D1' })
  })

  it('lists the untitled draft in GET /bills with isDraft so the list can label it', async () => {
    await post({ billNumber: 'D1', state: 'UT' })
    const res = await appFetch('https://x/api/bills', { headers: { Cookie: `session=${adminToken}` } })
    const body = await res.json<{ bills: Array<{ billNumber: string; title: string; isDraft: boolean }> }>()
    const found = body.bills.find(b => b.billNumber === 'D1')
    expect(found).toMatchObject({ title: '', isDraft: true })
  })
})

describe('PATCH /api/bills/:id/draft — clearing a title', () => {
  async function titledDraft(): Promise<string> {
    const res = await post({ billNumber: 'D1', state: 'UT', title: 'Placeholder title', sponsor: 'Rep. Doe' })
    expect(res.status).toBe(201)
    return (await res.json<{ id: string }>()).id
  }

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['null', null],
  ])('clears a draft title sent as %s, storing an empty string', async (_label, title) => {
    const id = await titledDraft()
    const res = await patch(id, { title })
    expect(res.status).toBe(200)
    expect((await res.json<{ title: string }>()).title).toBe('')
    expect((await row(id))?.title).toBe('')
  })

  it('leaves the title alone when the title key is omitted', async () => {
    const id = await titledDraft()
    const res = await patch(id, { sponsor: 'Rep. Roe' })
    expect(res.status).toBe(200)
    const r = await row(id)
    expect(r?.title).toBe('Placeholder title')
    expect(r?.sponsor).toBe('Rep. Roe')
  })

  it('clears the title alongside other edits in the same request', async () => {
    const id = await titledDraft()
    const res = await patch(id, { title: '', billNumber: 'D5', sponsor: '' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ title: '', billNumber: 'D5', sponsor: null })
    const r = await row(id)
    expect(r?.title).toBe('')
    expect(r?.billNumber).toBe('D5')
  })

  it('adds a title to an untitled draft later, trimmed', async () => {
    const { id } = await (await post({ billNumber: 'D1', state: 'UT' })).json<{ id: string }>()
    const res = await patch(id, { title: '  Draft bill title ' })
    expect(res.status).toBe(200)
    expect((await res.json<{ title: string }>()).title).toBe('Draft bill title')
    expect((await row(id))?.title).toBe('Draft bill title')
  })

  it('re-clearing an already untitled draft is a harmless no-op', async () => {
    const { id } = await (await post({ billNumber: 'D1', state: 'UT' })).json<{ id: string }>()
    const res = await patch(id, { title: '' })
    expect(res.status).toBe(200)
    expect((await row(id))?.title).toBe('')
  })

  it('does not clear the title when the request fails for another reason', async () => {
    const id = await titledDraft()
    const res = await patch(id, { title: '', state: '' })
    expect(res.status).toBe(400)
    expect((await row(id))?.title).toBe('Placeholder title')
  })

  it("cannot clear a filed bill's title through the draft edit endpoint", async () => {
    const filedId = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:111', title: 'Filed bill title' })
    const res = await patch(filedId, { title: '' })
    expect(res.status).toBe(400)
    expect((await row(filedId))?.title).toBe('Filed bill title')
  })

  it('still rejects a non-admin clearing a draft title', async () => {
    const id = await titledDraft()
    const res = await patch(id, { title: '' }, memberToken)
    expect(res.status).toBe(403)
    expect((await row(id))?.title).toBe('Placeholder title')
  })
})

describe('linking an untitled draft', () => {
  it("keeps the filed bill's own title", async () => {
    const { id: draftId } = await (await post({ billNumber: 'D1', state: 'UT' })).json<{ id: string }>()
    const filedId = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:1', title: 'Filed bill title', state: 'UT' })
    const res = await appFetch(`https://x/api/bills/${draftId}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filedId }),
    })
    expect(res.status).toBe(200)
    expect((await row(filedId))?.title).toBe('Filed bill title')
    expect(await row(draftId)).toBeUndefined()
  })
})

describe('GET /api/calendar/events — untitled draft display title', () => {
  const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

  it('labels an untitled draft "Untitled draft" and leaves titled and filed bills alone', async () => {
    const db = getDb(env.DB)
    const untitled = await seedBill({ billNumber: 'D1', title: '', state: 'RI', session: '2026', matchType: 'manual', isDraft: true })
    const titled = await seedBill({ billNumber: 'D2', title: 'Draft bill title', state: 'RI', session: '2026', matchType: 'manual', isDraft: true })
    const filedBlank = await seedBill({ billNumber: 'F1', title: '', state: 'RI', session: '2026', matchType: 'manual', isDraft: false })
    const eventId = crypto.randomUUID()
    await db.insert(calendarEvents).values({
      id: eventId, uid: 'custom-untitled@t', billId: null, source: 'custom',
      sequence: 0, date: isoDay(2), time: null, location: null,
      description: 'Working session', status: 'confirmed', eventHash: null,
    })
    await db.insert(calendarEventBills).values([
      { eventId, billId: untitled },
      { eventId, billId: titled },
      { eventId, billId: filedBlank },
    ])

    const res = await appFetch('https://x/api/calendar/events', { headers: { Cookie: `session=${memberToken}` } })
    expect(res.status).toBe(200)
    const events = await res.json<Array<{ uid: string; bills: Array<{ billNumber: string; billTitle: string }> }>>()
    const byNumber = new Map(events.find(e => e.uid === 'custom-untitled@t')!.bills.map(b => [b.billNumber, b.billTitle]))
    expect(byNumber.get('D1')).toBe('Untitled draft')
    expect(byNumber.get('D2')).toBe('Draft bill title')
    expect(byNumber.get('F1')).toBe('')
  })

  it('labels an untitled draft on a hearing event too', async () => {
    const draft = await seedBill({ billNumber: 'D9', title: '', state: 'RI', session: '2026', priority: 'high', isDraft: true })
    await seedCalendarEvent(draft, { uid: 'h-untitled@t', date: isoDay(3), description: 'Cmte' })
    const res = await appFetch('https://x/api/calendar/events', { headers: { Cookie: `session=${memberToken}` } })
    const events = await res.json<Array<{ uid: string; bills: Array<{ billTitle: string }> }>>()
    expect(events.find(e => e.uid === 'h-untitled@t')!.bills[0].billTitle).toBe('Untitled draft')
  })
})
