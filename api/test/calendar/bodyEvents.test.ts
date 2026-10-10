import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, calendarEvents, calendarEventBills } from '../../src/db/schema'
import { syncBodyEvents, type CentralBodyEvent } from '../../src/lib/bodyEvents'
import { hearingUid } from '../../src/lib/hearingUid'

// Body events on an instance (#297): central's answer to
// GET /tenants/:id/body-events in (fetch stubbed), and the instance's
// calendar, ICS feed, and config out.

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const HANDLE = 'legiscan:1012600769'
const IDENTITY = 'hearing|2026-10-23|public hearing on b26-0769'
const HEARING_UID = hearingUid(HANDLE, IDENTITY, 'bpc-test')
const CAPABLE = { DC: { bodyEvents: true, deadlines: true } }

function bodyEvent(o: Partial<CentralBodyEvent> = {}): CentralBodyEvent {
  return {
    uid: 'council-2408@lims.dccouncil.gov', state: 'DC', kind: 'hearing', type: 'Roundtable',
    date: isoDay(5), time: '10:00', timezone: 'America/New_York',
    committee: { committeeId: '3000000001', name: 'Committee on Housing' }, jointWith: null,
    location: 'Room 123 (Track C)', title: 'Housing roundtable',
    agenda: [{ topic: 'Improving Housing Conditions', billNumber: null }],
    url: 'https://lims.dccouncil.gov/Hearings/hearings/2408', eventHash: 'e1', cancelled: false,
    bills: [], covers: [], ...o,
  }
}

/** The Committee of the Whole's hearing on B26-0769, which covers the bill's own entry that day. */
const stadiumHearing = (o: Partial<CentralBodyEvent> = {}) => bodyEvent({
  uid: 'council-2405@lims.dccouncil.gov', type: 'Hearing', date: isoDay(10), time: '10:00',
  committee: { committeeId: '3000000002', name: 'Committee of the Whole' }, location: 'Room 412 (Track B)',
  title: 'Committee of the Whole hearing',
  agenda: [{ topic: 'Soccer Stadium Redevelopment and Maintenance Act of 2026', billNumber: 'B26-0769' }],
  url: 'https://lims.dccouncil.gov/Hearings/hearings/2405', eventHash: 'e2',
  bills: [HANDLE], covers: [{ billId: HANDLE, identityKey: IDENTITY }], ...o,
})

/** What central answers next. */
let central: { status?: number; capabilities?: Record<string, unknown>; events?: CentralBodyEvent[] }
const fetchMock = vi.fn()

let token: string
let billId: string

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  token = await seedSession(await seedUser({ email: 'a@b.com' }))
  const db = getDb(env.DB)
  await db.insert(associationConfig).values({ key: 'state_coverage', value: '["DC"]' })
  billId = await seedBill({ billNumber: 'B26-0769', state: 'DC', session: '2025-2026 Council Period 26', priority: 'high', externalId: HANDLE })
  // The bill's own hearing, as a notification from central left it.
  await seedCalendarEvent(billId, { uid: HEARING_UID, date: isoDay(10), time: '', location: '', description: 'Public Hearing on B26-0769' })
  central = { capabilities: CAPABLE, events: [bodyEvent(), stadiumHearing()] }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => {
    expect(String(url)).toMatch(/^https:\/\/central\.test\/api\/tenants\/bpc-test\/body-events\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/)
    if (central.status) return new Response('down', { status: central.status })
    return new Response(JSON.stringify({ capabilities: central.capabilities, events: central.events }), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const sync = () => syncBodyEvents(env as any, getDb(env.DB))

async function calendar() {
  const res = await SELF.fetch(`http://localhost/api/calendar/events?from=${isoDay(-30)}&to=${isoDay(60)}`, { headers: { Cookie: `session=${token}` } })
  expect(res.status).toBe(200)
  return res.json() as Promise<any[]>
}

async function feed() {
  const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
  // Unfolded, so a long line reads whole.
  return (await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()).replace(/\r?\n /g, '')
}

const row = (uid: string) => getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.uid, uid)).get()

describe('body events on an instance', () => {
  it('show on the calendar and in the ICS feed under central\'s UIDs, with their agenda bills, and the hearing they cover shows once', async () => {
    // Before: the bill's own hearing.
    expect((await calendar()).map(e => e.uid)).toEqual([HEARING_UID])

    await sync()
    const events = await calendar()
    expect(events.map(e => e.uid)).toEqual(['council-2408@lims.dccouncil.gov', 'council-2405@lims.dccouncil.gov'])
    expect(events[0]).toMatchObject({
      source: 'body', kind: 'hearing', time: '10:00', location: 'Room 123 (Track C)',
      description: 'Housing roundtable: Improving Housing Conditions',
      url: 'https://lims.dccouncil.gov/Hearings/hearings/2408', bills: [],
    })
    expect(events[1]).toMatchObject({
      description: 'Committee of the Whole hearing: Soccer Stadium Redevelopment and Maintenance Act of 2026',
      details: '- Soccer Stadium Redevelopment and Maintenance Act of 2026 (B26-0769)',
      bills: [expect.objectContaining({ id: billId, billNumber: 'B26-0769', priority: 'high' })],
    })
    expect((await row(HEARING_UID))?.coveredBy).toBe('council-2405@lims.dccouncil.gov')

    const ics = await feed()
    expect(ics).toContain('UID:council-2408@lims.dccouncil.gov')
    expect(ics).toContain('UID:council-2405@lims.dccouncil.gov')
    expect(ics).not.toContain(`UID:${HEARING_UID}`)
    expect(ics).toContain('SUMMARY:Committee of the Whole hearing: Soccer Stadium Redevelopment and Maintenance Act of 2026 — B26-0769')
    expect(ics).toContain('TZID=America/New_York')
  })

  it('bump an event\'s sequence when it changes, is cancelled, or comes back, and not otherwise', async () => {
    const uid = 'council-2408@lims.dccouncil.gov'
    await sync()
    await sync()
    expect(await row(uid)).toMatchObject({ sequence: 0, status: 'confirmed' })

    central.events = [bodyEvent({ time: '11:00', eventHash: 'e1b' }), stadiumHearing()]
    await sync()
    expect(await row(uid)).toMatchObject({ sequence: 1, time: '11:00' })

    central.events = [bodyEvent({ time: '11:00', eventHash: 'e1b', cancelled: true }), stadiumHearing()]
    await sync()
    expect(await row(uid)).toMatchObject({ sequence: 2, status: 'cancelled' })
    expect((await calendar()).find(e => e.uid === uid)).toMatchObject({ status: 'cancelled' })
    expect(await feed()).toMatch(/UID:council-2408@lims\.dccouncil\.gov[\s\S]*?STATUS:CANCELLED/)

    central.events = [bodyEvent({ time: '11:00', eventHash: 'e1b' }), stadiumHearing()]
    await sync()
    expect(await row(uid)).toMatchObject({ sequence: 3, status: 'confirmed' })
  })

  it('leave out an event cancelled before the instance ever had it', async () => {
    central.events = [bodyEvent({ cancelled: true })]
    await sync()
    expect(await row('council-2408@lims.dccouncil.gov')).toBeUndefined()
  })

  it('go when central stops sending them, and the hearing they covered shows again', async () => {
    await sync()
    central = { capabilities: {}, events: [] }
    await sync()
    expect((await calendar()).map(e => e.uid)).toEqual([HEARING_UID])
    expect((await row(HEARING_UID))?.coveredBy).toBeNull()
    expect(await getDb(env.DB).select().from(calendarEventBills).all()).toEqual([])
  })

  it('uncover an entry an event no longer covers', async () => {
    await sync()
    central.events = [bodyEvent(), stadiumHearing({ covers: [] })]
    await sync()
    expect((await row(HEARING_UID))?.coveredBy).toBeNull()
    expect((await calendar()).map(e => e.uid)).toContain(HEARING_UID)
  })

  it('stay as they are when central fails', async () => {
    await sync()
    central.status = 503
    await expect(sync()).rejects.toThrow('HTTP 503')
    expect((await calendar()).map(e => e.uid)).toEqual(['council-2408@lims.dccouncil.gov', 'council-2405@lims.dccouncil.gov'])
  })

  it('stand in for the entry they cover when the dashboard widget links to it', async () => {
    await sync()
    const covering = (await calendar()).find(e => e.uid === 'council-2405@lims.dccouncil.gov')
    // seedCalendarEvent's hash for the bill's own hearing.
    expect(covering.eventHashes).toEqual(['e2', 'h1'])
  })

  it('load a whole season of the legislature\'s calendar on the calendar page and in the feed', async () => {
    central.events = Array.from({ length: 150 }, (_, i) => bodyEvent({
      uid: `council-${3000 + i}@lims.dccouncil.gov`, date: isoDay(1 + (i % 50)), eventHash: `e${i}`,
      ...(i % 3 === 0 ? { bills: [HANDLE] } : {}),
    }))
    await sync()
    expect((await calendar()).filter(e => e.source === 'body')).toHaveLength(150)
    expect((await feed()).match(/UID:council-/g)).toHaveLength(150)
  })

  it('take over a fork\'s Council events in place, under the same UID and sequence', async () => {
    await getDb(env.DB).insert(calendarEvents).values({
      id: crypto.randomUUID(), uid: 'council-2408@lims.dccouncil.gov', billId: null, source: 'council', sequence: 4,
      date: isoDay(5), time: '10:00', description: 'Housing roundtable: Improving Housing Conditions', status: 'confirmed', eventHash: 'e1',
    })
    await sync()
    expect(await row('council-2408@lims.dccouncil.gov')).toMatchObject({ source: 'body', sequence: 4 })
  })
})

describe('state capabilities', () => {
  it('reach GET /config from the body-event sync', async () => {
    await sync()
    const config = await (await SELF.fetch('http://localhost/api/config', { headers: { Cookie: `session=${token}` } })).json() as any
    expect(config.capabilities).toEqual(CAPABLE)
  })

  it('are asked for once a day while no covered state has body events', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
    central = { capabilities: {}, events: [] }
    expect(await sync()).not.toBeNull()
    expect(await sync()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-10-11T12:30:00Z'))
    expect(await sync()).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
