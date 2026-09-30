import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, calendarEvents, calendarEventBills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'
import { syncCouncilCalendarEvents, COUNCIL_RULES_KEY, councilEventTitle, councilEventMatches, parseCouncilRules } from '../../src/lib/councilCalendar'
import { app } from '../../src/index'

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const ev = (id: number, over: Record<string, unknown>) => ({
  hearingId: id, date: day(10), time: '10:00', hearingType: 'Hearing', title: 'Health', jointWith: null,
  location: 'Room 412 (Track B)', topics: [], witnessList: null, url: `https://lims.dccouncil.gov/Hearings/hearings/${id}`,
  eventHash: `h${id}`, removedAt: null, ...over,
})
const EVENTS = [
  ev(1, { title: 'Youth Affairs', hearingType: 'Roundtable', time: '12:00', topics: [{ topic: "DYRS' Fifth Rulemaking on the Community Placement of Juvenile Offenders", number: null }] }),
  ev(2, { title: 'Legislative Meeting', hearingType: 'Meeting', time: '09:00', topics: [{ topic: 'Breakfast Meeting', number: null }] }),
  ev(3, { title: 'Health', hearingType: 'Budget Oversight Hearing', topics: [{ topic: 'Office of the Attorney General', number: null }] }),
  ev(4, { title: 'Health', topics: [{ topic: 'Clemency Board Waiver Authority Amendment Act of 2025', number: 'B26-0038' }] }),
  ev(5, { title: 'Health', topics: [{ topic: 'Porchfest Permitting Amendment Act of 2025', number: 'B26-0424' }] }),
  ev(6, { title: 'Committee of the Whole', hearingType: 'Hearing', topics: [{ topic: 'School designation', number: null }] }),
  ev(7, { title: 'Committee of the Whole', hearingType: 'Meeting', topics: [{ topic: 'Regular Meeting', number: null }] }),
]
const RULES = {
  include: [
    { committee: 'Youth Affairs' }, { committee: 'Judiciary and Public Safety' },
    { committee: 'Legislative Meeting' }, { committee: 'Committee of the Whole', type: 'Meeting' },
  ],
  topicKeywords: ['attorney general', 'youth rehabilitation'],
  trackedBills: true,
}

function serve(events: unknown[]) {
  vi.mocked(centralFetch).mockImplementation(async () => new Response(JSON.stringify(events), { status: 200 }))
}
async function setRules(rules: unknown) {
  await getDb(env.DB).insert(associationConfig).values({ key: COUNCIL_RULES_KEY, value: JSON.stringify(rules) })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify(rules) } })
}

let cookie: string
let clemencyId: string
beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.mocked(centralFetch).mockReset()
  cookie = `session=${await seedSession(await seedUser({ role: 'member', email: 'm@example.com', name: 'M' }))}`
  clemencyId = await seedBill({ billNumber: 'B26-0038', state: 'DC', matchType: 'keyword', externalId: 'legiscan:1012600038' })
  await seedBill({ billNumber: 'B26-0424', state: 'DC', matchType: null, externalId: 'legiscan:1012600424' })
})

describe('syncCouncilCalendarEvents', () => {
  it('does nothing for a team without calendar rules', async () => {
    serve(EVENTS)
    expect(await syncCouncilCalendarEvents(env as any, getDb(env.DB))).toBeNull()
    expect(centralFetch).not.toHaveBeenCalled()
  })

  it('keeps what the rules select: committees, meetings, topic keywords, tracked bills', async () => {
    await setRules(RULES)
    serve(EVENTS)
    const r = await syncCouncilCalendarEvents(env as any, getDb(env.DB))
    expect(r).toEqual({ upserted: 5, cancelled: 0, deleted: 0 })
    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.source, 'council')).all()
    const ids = rows.map(e => Number(e.uid.match(/council-(\d+)/)![1])).sort()
    // 1 Youth Affairs, 2 Legislative Meeting (breakfast), 3 OAG topic, 4 tracked bill, 7 COW meeting.
    // Not 5 (untracked bill) or 6 (COW hearing, not a meeting).
    expect(ids).toEqual([1, 2, 3, 4, 7])
    const dyrs = rows.find(e => e.uid.startsWith('council-1@'))!
    expect(dyrs).toMatchObject({ time: '12:00', location: 'Room 412 (Track B)', timezone: 'America/New_York' })
    expect(dyrs.description).toMatch(/^Youth Affairs roundtable: DYRS' Fifth Rulemaking/)
    const link = await getDb(env.DB).select().from(calendarEventBills).all()
    expect(link.map(l => l.billId)).toEqual([clemencyId])
  })

  it('cancels removed events, bumps the sequence on change, and deletes what the rules drop', async () => {
    await setRules(RULES)
    serve(EVENTS)
    await syncCouncilCalendarEvents(env as any, getDb(env.DB))
    serve(EVENTS.map(e => e.hearingId === 1 ? { ...e, time: '14:00', eventHash: 'h1b' } : e.hearingId === 2 ? { ...e, removedAt: '2026-09-29 00:00:00' } : e))
    const r = await syncCouncilCalendarEvents(env as any, getDb(env.DB))
    expect(r).toEqual({ upserted: 1, cancelled: 1, deleted: 0 })
    const db = getDb(env.DB)
    const moved = await db.select().from(calendarEvents).where(eq(calendarEvents.uid, 'council-1@lims.dccouncil.gov')).get()
    expect(moved).toMatchObject({ time: '14:00', sequence: 1 })
    const gone = await db.select().from(calendarEvents).where(eq(calendarEvents.uid, 'council-2@lims.dccouncil.gov')).get()
    expect(gone?.status).toBe('cancelled')

    await setRules({ include: [{ committee: 'Youth Affairs' }] })
    const r2 = await syncCouncilCalendarEvents(env as any, getDb(env.DB))
    expect(r2?.deleted).toBe(4)
  })
})

describe('calendar display', () => {
  it('shows Council events without a priority, and they supersede a date-only bill hearing that day', async () => {
    await setRules(RULES)
    serve(EVENTS)
    await syncCouncilCalendarEvents(env as any, getDb(env.DB))
    await getDb(env.DB).update((await import('../../src/db/schema')).bills).set({ priority: 'high' }).where(eq((await import('../../src/db/schema')).bills.id, clemencyId))
    await seedCalendarEvent(clemencyId, { date: day(10), time: undefined as any, description: 'Public Hearing on B26-0038', location: undefined as any })
    const res = await app.request(`/api/calendar/events?from=${day(0)}&to=${day(30)}`, { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    const events = await res.json() as any[]
    const sources = events.map(e => e.source)
    expect(sources.filter(s => s === 'council')).toHaveLength(5)
    expect(sources).not.toContain('hearing')
    const clemency = events.find(e => e.uid === 'council-4@lims.dccouncil.gov')
    expect(clemency.bills.map((b: any) => b.billNumber)).toEqual(['B26-0038'])
  })

  it('shows DC deadlines for any tracked bill, while bill hearings still need a priority', async () => {
    const porchfest = (await getDb(env.DB).select().from((await import('../../src/db/schema')).bills).where(eq((await import('../../src/db/schema')).bills.billNumber, 'B26-0424')).get())!.id
    await seedCalendarEvent(clemencyId, { source: 'deadline', date: day(5), time: undefined as any, location: undefined as any, description: "Mayor's response due", eventHash: 'd1' })
    await seedCalendarEvent(clemencyId, { date: day(6), description: 'Public Hearing on B26-0038', eventHash: 'h1' })
    // Untracked stub: its deadline stays off the calendar.
    await seedCalendarEvent(porchfest, { source: 'deadline', date: day(7), time: undefined as any, location: undefined as any, description: 'Congressional review ends', eventHash: 'd2' })
    const res = await app.request(`/api/calendar/events?from=${day(0)}&to=${day(30)}`, { headers: { Cookie: cookie } }, env)
    const events = await res.json() as any[]
    expect(events.map(e => [e.source, e.description])).toEqual([['deadline', "Mayor's response due"]])
    expect(events[0].bills.map((b: any) => b.billNumber)).toEqual(['B26-0038'])
  })

  it('titles an event by committee, type, and agenda', () => {
    expect(councilEventTitle(EVENTS[1] as any)).toBe('Legislative Meeting: Breakfast Meeting')
    expect(councilEventTitle({ ...(EVENTS[0] as any), topics: [{ topic: 'A', number: null }, { topic: 'B', number: null }, { topic: 'C', number: null }] }))
      .toBe('Youth Affairs roundtable: A; and 2 more')
  })
})

describe('council calendar settings', () => {
  let adminCookie: string
  beforeEach(async () => {
    adminCookie = `session=${await seedSession(await seedUser({ role: 'admin', email: 'a@example.com', name: 'A' }))}`
  })
  const call = (method: string, path: string, body?: unknown, who = adminCookie) => app.request(`/api/admin/council-calendar${path}`, {
    method, headers: { Cookie: who, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env)

  it('matches every event of a chosen hearing type, whichever committee holds it', () => {
    expect(councilEventMatches(EVENTS[2] as any, { types: ['Budget Oversight Hearing'] }, new Set())).toBe(true)
    expect(councilEventMatches(EVENTS[3] as any, { types: ['Budget Oversight Hearing'] }, new Set())).toBe(false)
  })

  it('validates and cleans rules', () => {
    expect(parseCouncilRules({ include: [{ committee: ' Youth Affairs ', type: '' }], topicKeywords: ['dyrs', 'dyrs', ' cfsa '] }))
      .toEqual({ include: [{ committee: 'Youth Affairs' }], types: [], topicKeywords: ['dyrs', 'cfsa'], trackedBills: false })
    expect(parseCouncilRules({ include: [{ type: 'Hearing' }] })).toMatch(/committee/)
    expect(parseCouncilRules({ topicKeywords: [''] })).toMatch(/non-empty/)
    expect(parseCouncilRules([])).toMatch(/object/)
  })

  it('offers known and live committees and types, saves rules, and syncs right away', async () => {
    serve(EVENTS)
    const got = await (await call('GET', '')).json() as any
    expect(got.rules).toBeNull()
    expect(got.committees).toEqual(expect.arrayContaining(['Youth Affairs', 'Legislative Meeting', 'Business and Economic Development']))
    expect(got.types).toEqual(expect.arrayContaining(['Performance Oversight Hearing', 'Budget Oversight Hearing']))

    const put = await call('PUT', '', { rules: { include: [{ committee: 'Youth Affairs' }], trackedBills: false } })
    expect(put.status).toBe(200)
    expect((await put.json() as any).sync.upserted).toBe(1)
    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.source, 'council')).all()
    expect(rows.map(r => r.uid)).toEqual(['council-1@lims.dccouncil.gov'])
  })

  it('previews without saving', async () => {
    serve(EVENTS)
    const res = await call('POST', '/preview', { rules: { types: ['Budget Oversight Hearing'] } })
    const body = await res.json() as any
    expect(body.events.map((e: any) => e.title)).toEqual(['Health budget oversight hearing: Office of the Attorney General'])
    expect(await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, COUNCIL_RULES_KEY)).get()).toBeUndefined()
  })

  it('turning it off removes mirrored events and the rules', async () => {
    serve(EVENTS)
    await setRules(RULES)
    await syncCouncilCalendarEvents(env as any, getDb(env.DB))
    const res = await call('PUT', '', { rules: null })
    expect(res.status).toBe(200)
    expect(await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.source, 'council')).all()).toEqual([])
    expect(await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, COUNCIL_RULES_KEY)).get()).toBeUndefined()
  })

  it('flags a saved committee the Council no longer has', async () => {
    vi.mocked(centralFetch).mockImplementation(async (_env: unknown, path: string) => path.startsWith('/bills/council-directory')
      ? new Response(JSON.stringify({ committees: [{ name: 'Committee on Youth Affairs' }, { name: 'Committee of the Whole' }, { name: 'Committee on Health' }] }), { status: 200 })
      : new Response(JSON.stringify(EVENTS), { status: 200 }))
    await setRules({ include: [{ committee: 'Youth Affairs' }, { committee: 'Legislative Meeting' }, { committee: 'Recreation and Libraries' }] })
    const got = await (await call('GET', '')).json() as any
    expect(got.staleCommittees).toEqual(['Recreation and Libraries'])
    expect(got.committees).toContain('Recreation and Libraries')
  })

  it('is admin-only', async () => {
    expect((await call('PUT', '', { rules: {} }, cookie)).status).toBe(403)
  })
})

