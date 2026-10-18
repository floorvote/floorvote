import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, calendarEvents, calendarEventBills } from '../../src/db/schema'
import { syncBodyEvents, type CentralBodyEvent } from '../../src/lib/bodyEvents'
import { hearingUid } from '../../src/lib/hearingUid'
import { app } from '../../src/index'

// Body events on an instance (#297): central's answer to
// GET /tenants/:id/body-events in (fetch stubbed), and the instance's
// calendar, ICS feed, and config out.

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const HANDLE = 'legiscan:1012600769'
const IDENTITY = 'hearing|2026-10-23|public hearing on b26-0769'
const HEARING_UID = hearingUid(HANDLE, IDENTITY, 'bpc-test')
const CAPABLE = { DC: { bodyEvents: true, deadlines: true } }
const LIMS_CREDIT = { id: 'lims', name: 'DC Council LIMS', url: 'https://lims.dccouncil.gov', note: 'Legislative data comes from the Council of the District of Columbia\'s LIMS.' }
const LEGISCAN_CREDIT = { id: 'legiscan', name: 'LegiScan', url: 'https://legiscan.com', note: 'From LegiScan.', license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } }
const DC_ATTRIBUTION = { providers: [LIMS_CREDIT] }

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
let central: { status?: number; capabilities?: Record<string, unknown>; attribution?: unknown; dashboardUrl?: unknown; events?: CentralBodyEvent[] }
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
  central = { capabilities: CAPABLE, attribution: DC_ATTRIBUTION, events: [bodyEvent(), stadiumHearing()] }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => {
    expect(String(url)).toMatch(/^https:\/\/central\.test\/api\/tenants\/bpc-test\/body-events\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/)
    if (central.status) return new Response('down', { status: central.status })
    return new Response(JSON.stringify({ capabilities: central.capabilities, attribution: central.attribution, dashboardUrl: central.dashboardUrl, events: central.events }), { headers: { 'content-type': 'application/json' } })
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

  it('are cancelled, never deleted, when central stops sending one while the state still has body events', async () => {
    await sync()
    central.events = [bodyEvent()]
    await sync()
    expect(await row('council-2405@lims.dccouncil.gov')).toMatchObject({ status: 'cancelled', sequence: 1 })
    // Central sends a cancelled event as cancelled. One it stops sending left
    // the instance's coverage or its state's provider, and the bill's own
    // hearing, still confirmed, shows again rather than hide behind it.
    expect((await row(HEARING_UID))?.coveredBy).toBeNull()
    expect((await calendar()).map(e => e.uid)).toContain(HEARING_UID)
    await sync()
    expect(await row('council-2405@lims.dccouncil.gov')).toMatchObject({ status: 'cancelled', sequence: 1 })
  })

  it('keep covering the entry when central sends the event as cancelled, so the cancellation shows once', async () => {
    await sync()
    central.events = [bodyEvent(), stadiumHearing({ cancelled: true })]
    await sync()
    expect(await row('council-2405@lims.dccouncil.gov')).toMatchObject({ status: 'cancelled' })
    expect((await row(HEARING_UID))?.coveredBy).toBe('council-2405@lims.dccouncil.gov')
  })

  it('stay as they are when central answers without its events or capabilities', async () => {
    await sync()
    for (const answer of [{ capabilities: CAPABLE }, { events: [bodyEvent()] }, { capabilities: CAPABLE, events: null }]) {
      central = answer as typeof central
      await expect(sync()).rejects.toThrow('no events or capabilities')
    }
    expect((await calendar()).map(e => e.uid)).toEqual(['council-2408@lims.dccouncil.gov', 'council-2405@lims.dccouncil.gov'])
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

  it('carry the name members call the legislature\'s body, for the Calendar page\'s control (#420)', async () => {
    central = { capabilities: { DC: { bodyEvents: true, deadlines: true, bodyName: 'Council' } }, events: [bodyEvent()] }
    await sync()
    const config = await (await SELF.fetch('http://localhost/api/config', { headers: { Cookie: `session=${token}` } })).json() as any
    expect(config.capabilities).toEqual({ DC: { bodyEvents: true, deadlines: true, bodyName: 'Council' } })
  })

  it('are asked for every hour while no covered state has body events, so a newly claimed state shows within the hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
    central = { capabilities: {}, attribution: DC_ATTRIBUTION, events: [] }
    expect(await sync()).not.toBeNull()
    expect(await sync()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-10-10T12:29:00Z'))
    expect(await sync()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-10-10T12:31:00Z'))
    expect(await sync()).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date('2026-10-10T13:31:00Z'))
    central = { capabilities: CAPABLE, events: [bodyEvent()] }
    expect((await sync())?.upserted).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('data attribution', () => {
  const configAttribution = async () => (await (await SELF.fetch('http://localhost/api/config', { headers: { Cookie: `session=${token}` } })).json() as any).attribution

  it('leaves attribution out of GET /config until central has answered', async () => {
    expect(await configAttribution()).toBeUndefined()
  })

  it('reaches GET /config from the body-event sync, as central declares it', async () => {
    await sync()
    expect(await configAttribution()).toEqual(DC_ATTRIBUTION)
    // A claim moves a state to another provider, and the next answer says so.
    central.attribution = { providers: [LEGISCAN_CREDIT, LIMS_CREDIT] }
    await sync()
    expect(await configAttribution()).toEqual({ providers: [LEGISCAN_CREDIT, LIMS_CREDIT] })
  })

  it('keeps what it has when central sends none', async () => {
    await sync()
    central = { capabilities: {}, events: [] }
    await sync()
    expect(await configAttribution()).toEqual(DC_ATTRIBUTION)
  })

  it('drops a credit that is not a name and http(s) link, and leaves attribution out when none is left', async () => {
    central.attribution = {
      providers: [
        { ...LIMS_CREDIT, url: 'javascript:alert(1)' },
        { ...LEGISCAN_CREDIT, id: 'ok', license: undefined },
        { id: 'x', name: '', url: 'https://example.test' },
      ],
    }
    await sync()
    expect((await configAttribution()).providers).toEqual([{ id: 'ok', name: 'LegiScan', url: 'https://legiscan.com', note: 'From LegiScan.' }])
    central.attribution = { providers: [{ ...LIMS_CREDIT, url: '/relative' }] }
    await sync()
    expect(await configAttribution()).toBeUndefined()
  })

  it('keeps a credit with no note, with or without a license, and still keeps a note when one is sent', async () => {
    const { note: _n, ...licensedNoNote } = LEGISCAN_CREDIT
    const { note: _m, ...limsNoNote } = LIMS_CREDIT
    central.attribution = { providers: [licensedNoNote, limsNoNote, { ...LIMS_CREDIT, id: 'noted' }] }
    await sync()
    expect(await configAttribution()).toEqual({ providers: [licensedNoNote, limsNoNote, { ...LIMS_CREDIT, id: 'noted' }] })
  })

  it('drops the whole credit, not just its license, when the license has no usable link', async () => {
    central.attribution = {
      providers: [
        { ...LEGISCAN_CREDIT, license: { name: 'CC BY 4.0', url: 'javascript:alert(1)' } },
        { ...LEGISCAN_CREDIT, id: 'nameless', license: { url: 'https://creativecommons.org/licenses/by/4.0/' } },
        LIMS_CREDIT,
      ],
    }
    await sync()
    expect(await configAttribution()).toEqual(DC_ATTRIBUTION)
  })

  it('accepts an http link, and cuts a name and note to a sensible length', async () => {
    central.attribution = { providers: [{ id: 'long', name: 'N'.repeat(300), url: 'http://legislature.example.test', note: 'T'.repeat(900) }] }
    await sync()
    expect((await configAttribution()).providers).toEqual([{ id: 'long', name: 'N'.repeat(200), url: 'http://legislature.example.test', note: 'T'.repeat(500) }])
  })

  it('leaves attribution out when the stored attribution is corrupt', async () => {
    const db = getDb(env.DB)
    for (const value of ['not json', '{"data":"x"}', '{"data":{"providers":"x"}}', 'null']) {
      await db.insert(associationConfig).values({ key: 'data_attribution', value }).onConflictDoUpdate({ target: associationConfig.key, set: { value } })
      expect(await configAttribution()).toBeUndefined()
    }
  })

  it('ignores DATA_SOURCES, which an earlier release read from the instance\'s own settings', async () => {
    await sync()
    const res = await app.request('/api/config', { headers: { Cookie: `session=${token}` } }, { ...env, DATA_SOURCES: 'legiscan' })
    const body = await res.json() as any
    expect(body.attribution).toEqual(DC_ATTRIBUTION)
    expect(body.dataSources).toBeUndefined()
  })
})

describe('central dashboard address', () => {
  const db = () => getDb(env.DB)
  const configDashboardUrl = async () => (await (await SELF.fetch('http://localhost/api/config', { headers: { Cookie: `session=${token}` } })).json() as any).centralDashboardUrl

  it('is unknown on GET /config until central has told the instance', async () => {
    expect(await configDashboardUrl()).toBeUndefined()
  })

  it('reaches GET /config from the body-event sync', async () => {
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    expect(await configDashboardUrl()).toBe('https://admin.example.com')
  })

  it('keeps what it has when central sends none, as an older central does', async () => {
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    central.dashboardUrl = undefined
    await sync()
    expect(await configDashboardUrl()).toBe('https://admin.example.com')
  })

  it('drops a trailing slash, so a link built from it has no double slash', async () => {
    central.dashboardUrl = 'https://admin.example.com//'
    await sync()
    expect(await configDashboardUrl()).toBe('https://admin.example.com')
  })

  it('ignores an address that is not an http(s) URL, since the page renders it as a link', async () => {
    central.dashboardUrl = 'javascript:alert(1)'
    await sync()
    expect(await configDashboardUrl()).toBeUndefined()
  })

  it('does not let a bad address overwrite a good one', async () => {
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://admin.example.com', '/relative', 'not a url', '', 42, {}, ['https://other.example.com']]) {
      central.dashboardUrl = bad
      await sync()
      expect(await configDashboardUrl(), JSON.stringify(bad)).toBe('https://admin.example.com')
    }
  })

  it('takes a new good address over an old one', async () => {
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    central.dashboardUrl = 'https://dash.example.org'
    await sync()
    expect(await configDashboardUrl()).toBe('https://dash.example.org')
  })

  it('forgets the address when central says, with an explicit null, that it has none', async () => {
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    central.dashboardUrl = null
    await sync()
    expect(await configDashboardUrl()).toBeUndefined()
    expect(await db().select().from(associationConfig).where(eq(associationConfig.key, 'central_dashboard_url')).get()).toBeUndefined()
  })

  it('has nothing to forget when central says null before it ever sent one', async () => {
    central.dashboardUrl = null
    await sync()
    expect(await configDashboardUrl()).toBeUndefined()
  })

  it('learns the address again after forgetting it', async () => {
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    central.dashboardUrl = null
    await sync()
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    expect(await configDashboardUrl()).toBe('https://admin.example.com')
  })

  it('keeps the address across several syncs that send no key, as an older central does', async () => {
    central.dashboardUrl = 'https://admin.example.com'
    await sync()
    central.dashboardUrl = undefined
    await sync()
    await sync()
    expect(await configDashboardUrl()).toBe('https://admin.example.com')
  })

  it('still reconciles events when the address is cleared', async () => {
    central.dashboardUrl = null
    await sync()
    expect((await calendar()).map(e => e.uid)).toEqual(['council-2408@lims.dccouncil.gov', 'council-2405@lims.dccouncil.gov'])
  })

  // Read-side validation (these pass before the change by design: they guard the
  // existing check on read, which the sync tests above never reach).
  it('does not serve a stored address that is not an http(s) URL', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://admin.example.com', '/relative', 'not a url', '']) {
      await db().insert(associationConfig).values({ key: 'central_dashboard_url', value: bad }).onConflictDoUpdate({ target: associationConfig.key, set: { value: bad } })
      expect(await configDashboardUrl(), bad).toBeUndefined()
    }
  })

  it('serves a stored address without its trailing slashes', async () => {
    await db().insert(associationConfig).values({ key: 'central_dashboard_url', value: 'https://admin.example.com/' })
    expect(await configDashboardUrl()).toBe('https://admin.example.com')
  })
})

// Release 1 of the neutral handle rename (#305): central may name a bill by
// either form of its handle, and the instance finds the same bill and the same
// calendar entry. Entry UIDs keep the legacy form.
describe('body events naming bills by a neutral handle', () => {
  const NEUTRAL = HANDLE.replace('legiscan:', 'bill:')

  it('links an agenda bill the instance holds under the legacy handle', async () => {
    central.events = [stadiumHearing({ bills: [NEUTRAL], covers: [] })]
    await sync()
    const db = getDb(env.DB)
    const ev = await db.select().from(calendarEvents).where(eq(calendarEvents.uid, 'council-2405@lims.dccouncil.gov')).get()
    const links = await db.select().from(calendarEventBills).where(eq(calendarEventBills.eventId, ev!.id)).all()
    expect(links.map(l => l.billId)).toEqual([billId])
  })

  it('links the same bill whichever form names it', async () => {
    central.events = [stadiumHearing({ bills: [HANDLE, NEUTRAL], covers: [] })]
    await sync()
    const db = getDb(env.DB)
    const ev = await db.select().from(calendarEvents).where(eq(calendarEvents.uid, 'council-2405@lims.dccouncil.gov')).get()
    expect((await db.select().from(calendarEventBills).where(eq(calendarEventBills.eventId, ev!.id)).all())).toHaveLength(1)
  })

  it('covers the bill\'s own entry, found by its legacy UID', async () => {
    central.events = [stadiumHearing({ covers: [{ billId: NEUTRAL, identityKey: IDENTITY }] })]
    await sync()
    expect(HEARING_UID).toBe('hearing-legiscan-1012600769-hearing-2026-10-23-public-hearing-on-b26-0769@bpc-test')
    expect((await row(HEARING_UID))?.coveredBy).toBe('council-2405@lims.dccouncil.gov')
  })
})

// Release 2's migration may have rewritten the instance's bills to `bill:<n>` before this worker
// is replaced, so agenda bills resolve by either spelling (#305).
describe('body events for a bill already stored under the neutral handle', () => {
  beforeEach(async () => {
    await getDb(env.DB).update(bills).set({ externalId: HANDLE.replace('legiscan:', 'bill:') }).where(eq(bills.id, billId))
  })

  it.each([HANDLE, HANDLE.replace('legiscan:', 'bill:')])('links an agenda bill named %s', async (handle) => {
    central.events = [stadiumHearing({ bills: [handle], covers: [] })]
    await sync()
    const db = getDb(env.DB)
    const ev = await db.select().from(calendarEvents).where(eq(calendarEvents.uid, 'council-2405@lims.dccouncil.gov')).get()
    expect((await db.select().from(calendarEventBills).where(eq(calendarEventBills.eventId, ev!.id)).all()).map(l => l.billId)).toEqual([billId])
  })
})
