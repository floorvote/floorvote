import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, calendarEventBills, deepAnalyses } from '../../src/db/schema'
import { app } from '../../src/index'
import { ensureDeepRequest } from '../../src/lib/deepAnalysis'

const TOKEN = 'worker-test-token'
const deepEnv = { ...env, DEEP_ANALYSIS_ENABLED: 'true', DEEP_WORKER_TOKEN: TOKEN, CENTRAL_API_URL: 'https://central.test' }
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

const DIRECTORY = {
  committees: [{ slug: 'committee-on-youth-affairs', name: 'Committee on Youth Affairs', url: 'https://dccouncil.gov/committees/committee-on-youth-affairs/',
    chair: { name: 'Ward 5 Councilmember Zachary Parker', url: null }, members: [{ name: 'Ward 2 Councilmember Brooke Pinto', url: null }],
    staff: [{ name: 'Allison Bailey', title: 'Legislative Assistant', email: 'abailey@dccouncil.gov', phone: '(202) 727-7774', url: null }],
    agencies: ['Department of Youth Rehabilitation Services'] }],
  people: [], updatedAt: '2026-09-30 09:00:00',
  councilmembers: [
    { name: 'Zachary Parker', role: 'Councilmember', termStart: '2023-01-02', termEnd: '2027-01-01', current: true },
    { name: 'Kenyan R. McDuffie', role: 'Councilmember', termStart: '2023-01-02', termEnd: '2026-01-05', current: false },
    { name: 'Trayon White, Sr.', role: 'Councilmember', termStart: '2025-01-02', termEnd: '2025-02-04', current: true, note: 'Listed as serving on dccouncil.gov. LIMS shows the term ending 2025-02-04.' },
  ],
}
const RICH = {
  byId: {
    '1012600100': { votes: [{ id: '1', motionText: 'First reading', date: '2026-07-07', result: 'pass', chamber: 'C', memberVotes: [{ name: 'Zachary Parker', vote: 'Yes' }, { name: 'Brooke Pinto', vote: 'No' }] }] },
    '1012500345': { votes: [{ id: '2', motionText: 'Final reading', date: '2024-03-05', result: 'pass', chamber: 'C', memberVotes: [{ name: 'Zachary Parker', vote: 'No' }] }] },
  },
}

async function call(path: string, init: RequestInit = {}, e: Record<string, unknown> = deepEnv) {
  const ctx = createExecutionContext()
  const res = await app.request(path, init, e, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
const json = (method: string, cookie: string, body?: unknown): RequestInit => ({
  method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

let high: string, secureDc: string, admin: string, member: string
beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (String(url).includes('/rich-batch')) return new Response(JSON.stringify(RICH), { status: 200 })
    if (String(url).includes('/council-directory')) return new Response(JSON.stringify(DIRECTORY), { status: 200 })
    return new Response(JSON.stringify({ type: 'html', content: '<p>Sec. 2.</p>' }), { status: 200 })
  }))
  const db = getDb(env.DB)
  high = await seedBill({ billNumber: 'B26-0100', state: 'DC', priority: 'high', externalId: 'legiscan:1012600100' })
  secureDc = await seedBill({ billNumber: 'B25-0345', title: 'Secure DC Omnibus Amendment Act of 2024', state: 'DC', matchType: 'manual', externalId: 'legiscan:1012500345' })
  await db.update(bills).set({ lastAiTextHash: 'text-v1' }).where(eq(bills.id, high))
  admin = `session=${await seedSession(await seedUser({ role: 'admin', email: 'a@example.com' }))}`
  member = `session=${await seedSession(await seedUser({ role: 'member', email: 'm@example.com' }))}`
})

describe('team documents', () => {
  it('lets admins add and remove links, members only read, and requires https', async () => {
    expect((await call(`/api/links/bill/${high}`, json('POST', member, { title: 'Letter', url: 'https://docs.google.com/d/1' }))).status).toBe(403)
    expect((await call(`/api/links/bill/${high}`, json('POST', admin, { title: 'Letter', url: 'http://docs.google.com/d/1' }))).status).toBe(400)
    const add = await call(`/api/links/bill/${high}`, json('POST', admin, { title: 'Joint comment letter', url: 'https://docs.google.com/d/1' }))
    expect(add.status).toBe(201)
    const { id } = await add.json() as { id: string }
    const list = await (await call(`/api/links/bill/${high}`, { headers: { Cookie: member } })).json() as { links: { title: string }[] }
    expect(list.links.map(l => l.title)).toEqual(['Joint comment letter'])
    expect((await call(`/api/links/${id}`, json('DELETE', member))).status).toBe(403)
    expect((await call(`/api/links/${id}`, json('DELETE', admin))).status).toBe(204)
  })

  it('adding a document to a priority bill queues a fresh analysis', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const before = (await db.select().from(deepAnalyses).get())!
    await db.update(deepAnalyses).set({ status: 'done', content: '{}', contentInputHash: before.inputHash }).where(eq(deepAnalyses.id, before.id))
    await call(`/api/links/bill/${high}`, json('POST', admin, { title: 'Testimony', url: 'https://docs.google.com/d/2' }))
    const after = (await db.select().from(deepAnalyses).get())!
    expect(after.status).toBe('pending')
    expect(after.inputHash).not.toBe(before.inputHash)
  })

  it('hands the worker the team documents, committee rosters, votes, and the voting record', async () => {
    await call(`/api/links/bill/${high}`, json('POST', admin, { title: 'Joint comment letter', url: 'https://docs.google.com/d/1' }))
    const row = (await getDb(env.DB).select().from(deepAnalyses).get())!
    const input = await (await call(`/api/deep/worker/requests/${row.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any
    expect(input.teamDocuments).toEqual([{ title: 'Joint comment letter', url: 'https://docs.google.com/d/1' }])
    expect(input.committees[0]).toMatchObject({ name: 'Committee on Youth Affairs', chair: 'Ward 5 Councilmember Zachary Parker', staff: ['Allison Bailey, Legislative Assistant'] })
    expect(JSON.stringify(input.committees)).not.toContain('abailey@')
    expect(input.councilmembers).toEqual([
      { name: 'Zachary Parker', role: 'Councilmember', termStart: '2023-01-02', termEnd: '2027-01-01', status: 'current' },
      { name: 'Kenyan R. McDuffie', role: 'Councilmember', termStart: '2023-01-02', termEnd: '2026-01-05', status: 'former' },
      { name: 'Trayon White, Sr.', role: 'Councilmember', termStart: '2025-01-02', termEnd: '2025-02-04', status: 'current', note: 'Listed as serving on dccouncil.gov. LIMS shows the term ending 2025-02-04.' },
    ])
    expect(input.bill.votes[0].memberVotes).toEqual([{ name: 'Zachary Parker', vote: 'Yes' }, { name: 'Brooke Pinto', vote: 'No' }])
    expect(input.votingRecord.map((b: any) => b.number)).toEqual(['B25-0345'])
    expect(input.votingRecord[0].votes[0].memberVotes).toEqual([{ name: 'Zachary Parker', vote: 'No' }])
  })

  it('links hearing documents to Council events', async () => {
    const ev = await seedCalendarEvent(high, { source: 'council', uid: 'council-7@x', date: day(4) })
    expect((await call(`/api/links/event/${ev}`, json('POST', admin, { title: 'Redline', url: 'https://docs.google.com/d/3' }))).status).toBe(201)
    expect((await call(`/api/links/event/nope`, json('POST', admin, { title: 'Redline', url: 'https://docs.google.com/d/3' }))).status).toBe(404)
  })

  it('lists the Council events a bill is on, so its page can show their briefs and documents', async () => {
    const council = await seedCalendarEvent(high, { source: 'council', uid: 'council-8@x', date: day(4), description: 'Youth Affairs roundtable' })
    const gone = await seedCalendarEvent(high, { source: 'council', uid: 'council-9@x', date: day(5), status: 'cancelled' })
    const bare = await seedCalendarEvent(high, { date: day(4), description: 'Date-only hearing' })
    for (const eventId of [council, gone, bare]) await getDb(env.DB).insert(calendarEventBills).values({ eventId, billId: high })
    const res = await call(`/api/deep/bill/${high}/hearings`, { headers: { Cookie: member } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: true, events: [{ id: council, date: day(4), time: '14:00:00', description: 'Youth Affairs roundtable' }] })
    expect((await call(`/api/deep/bill/${high}/hearings`)).status).toBe(401)
  })
})

describe('directory', () => {
  it('serves the Council directory to members', async () => {
    const res = await call('/api/directory', { headers: { Cookie: member } })
    expect(res.status).toBe(200)
    expect((await res.json() as any).committees[0].staff[0].email).toBe('abailey@dccouncil.gov')
    expect((await call('/api/directory')).status).toBe(401)
  })
})
