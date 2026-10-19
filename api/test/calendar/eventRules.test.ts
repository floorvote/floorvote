import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, calendarEvents } from '../../src/db/schema'
import { syncBodyEvents, type CentralBodyEvent } from '../../src/lib/bodyEvents'
import { hearingUid } from '../../src/lib/hearingUid'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { COUNCIL_CALENDAR_TOPIC } from '../../../shared/eventRules'

// Event rules on an instance (#298): central's body events and rule options in
// (fetch stubbed), an admin's rules saved through the settings route, and the
// instance's calendar, ICS feed, and week-ahead email out.

const sendBatch = vi.hoisted(() => vi.fn(async () => ({ sent: 1, failed: 0 })))
vi.mock('../../src/lib/email', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/lib/email')>(), senderFor: (e: unknown) => ({ sendBatch: (messages: unknown[]) => (sendBatch as (...a: unknown[]) => unknown)(e, messages) }) }))

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const HANDLE = 'legiscan:1012600769'
const IDENTITY = 'hearing|2026-10-23|public hearing on b26-0769'
const HEARING_UID = hearingUid(HANDLE, IDENTITY, 'bpc-test')
const HOUSING = { committeeId: '3000000001', name: 'Committee on Housing' }
const COW = { committeeId: '3000000002', name: 'Committee of the Whole' }
const ROUNDTABLE = 'council-2408@lims.dccouncil.gov'
const STADIUM = 'council-2405@lims.dccouncil.gov'
const MEETING = 'council-2045@lims.dccouncil.gov'

function bodyEvent(o: Partial<CentralBodyEvent> = {}): CentralBodyEvent {
  return {
    uid: ROUNDTABLE, state: 'DC', kind: 'hearing', type: 'Roundtable',
    date: isoDay(2), time: '10:00', timezone: 'America/New_York',
    committee: HOUSING, jointWith: null, location: 'Room 123', title: 'Housing roundtable',
    agenda: [{ topic: 'Improving Housing Conditions at the DC Housing Authority', billNumber: null }],
    url: 'https://lims.dccouncil.gov/Hearings/hearings/2408', eventHash: 'e1', cancelled: false,
    bills: [], covers: [], ...o,
  }
}

/** The Committee of the Whole's hearing on a prioritized bill, which covers the bill's own entry that day. */
const stadiumHearing = () => bodyEvent({
  uid: STADIUM, type: 'Hearing', date: isoDay(4), committee: COW, title: 'Committee of the Whole hearing',
  agenda: [{ topic: 'Soccer Stadium Redevelopment Act of 2026', billNumber: 'B26-0769' }],
  url: 'https://lims.dccouncil.gov/Hearings/hearings/2405', eventHash: 'e2',
  bills: [HANDLE], covers: [{ billId: HANDLE, identityKey: IDENTITY }],
})

/** A whole-Council meeting: no committee. */
const legislativeMeeting = () => bodyEvent({
  uid: MEETING, kind: 'meeting', type: 'Meeting', date: isoDay(3), committee: null, title: 'Legislative Meeting',
  agenda: [], url: 'https://lims.dccouncil.gov/Hearings/hearings/2045', eventHash: 'e3',
})

let central: { status?: number; optionsStatus?: number; optionsStates?: unknown; bodyEvents?: boolean; events: CentralBodyEvent[] }
const fetchMock = vi.fn()
let admin: string
let member: string
let billId: string

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  admin = await seedSession(await seedUser({ role: 'admin', email: 'admin@b.com' }))
  member = await seedSession(await seedUser({ email: 'member@b.com' }))
  const db = getDb(env.DB)
  await db.insert(associationConfig).values({ key: 'state_coverage', value: '["DC"]' })
  billId = await seedBill({ billNumber: 'B26-0769', state: 'DC', priority: 'high', externalId: HANDLE })
  await seedCalendarEvent(billId, { uid: HEARING_UID, kind: 'hearing', date: isoDay(4), time: '', location: '', description: 'Public Hearing on B26-0769' })
  central = { events: [bodyEvent(), stadiumHearing(), legislativeMeeting()] }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => {
    if (central.status) return new Response('down', { status: central.status })
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (String(url).startsWith('https://central.test/api/tenants/bpc-test/body-events?')) {
      return json({ capabilities: { DC: { bodyEvents: central.bodyEvents ?? true, deadlines: true } }, events: central.events })
    }
    if (String(url) === 'https://central.test/api/tenants/bpc-test/body-event-options') {
      if (central.optionsStatus) return new Response('down', { status: central.optionsStatus })
      if (central.optionsStates) return json({ states: central.optionsStates })
      return json({ states: { DC: {
        committees: [{ ...COW, chamber: 'C' }, { ...HOUSING, chamber: 'C' }, { committeeId: '3000000003', name: 'Committee on Health', chamber: 'C' }],
        kinds: [{ kind: 'hearing', types: ['Hearing', 'Roundtable'] }, { kind: 'meeting', types: ['Meeting'] }],
      } } })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  sendBatch.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const sync = () => syncBodyEvents(env as any, getDb(env.DB))

async function api(path: string, init: RequestInit = {}, session = admin) {
  return SELF.fetch(`http://localhost/api${path}`, { ...init, headers: { Cookie: `session=${session}`, 'content-type': 'application/json' } })
}
const saveRules = (rules: unknown, session = admin) => api('/admin/event-rules', { method: 'PUT', body: JSON.stringify({ rules }) }, session)

async function calendarUids() {
  const res = await api(`/calendar/events?from=${isoDay(-30)}&to=${isoDay(60)}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { uid: string }[]).map(e => e.uid).sort()
}

async function feed() {
  const info = await (await api('/calendar/info')).json() as { slug: string }
  return (await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()).replace(/\r?\n /g, '')
}

const RULES = { committees: [HOUSING], kinds: [], topics: [], trackedBills: false }

/** Take the bill's priority away, leaving it tracked by keyword, so rules alone decide the stadium hearing. */
const unprioritize = () => getDb(env.DB).update(bills).set({ priority: null, matchType: 'keyword' }).where(eq(bills.id, billId))

describe('event rules', () => {
  it('show every body event until an admin saves rules', async () => {
    await sync()
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
    const res = await api('/admin/event-rules')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({ rules: null, hasBodyEvents: true, optionsError: null })
    expect(body.committees.map((c: any) => c.name)).toEqual(['Committee of the Whole', 'Committee on Housing', 'Committee on Health'])
    expect(body.kinds).toEqual([{ kind: 'hearing', types: ['Hearing', 'Roundtable'] }, { kind: 'meeting', types: ['Meeting'] }])
    expect(body.events.map((e: any) => e.facets.title)).toEqual(['Housing roundtable', 'Legislative Meeting', 'Committee of the Whole hearing'])
    expect(body.events[2]).toMatchObject({ trackedOnAgenda: true, prioritizedOnAgenda: true, facets: { committeeId: COW.committeeId, kind: 'hearing', type: 'Hearing' } })
  })

  it('hide what saved rules don\'t select, at once and without asking central, but never an event with a prioritized bill on its agenda', async () => {
    await sync()
    fetchMock.mockClear()
    const res = await saveRules(RULES)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rules: RULES, shown: 2, hidden: 1 })
    expect(fetchMock).not.toHaveBeenCalled()

    // The stadium hearing has the prioritized bill on its agenda, so it shows, in place of the bill's own entry.
    expect(await calendarUids()).toEqual([ROUNDTABLE, STADIUM].sort())
    const ics = await feed()
    expect(ics).toContain(`UID:${ROUNDTABLE}`)
    expect(ics).toContain(`UID:${STADIUM}`)
    expect(ics).not.toContain(`UID:${HEARING_UID}`)
    expect(ics).not.toContain(`UID:${MEETING}`)
  })

  it('show a bill prioritized since the rules ran: its own entry at once, then the event on the hourly sync', async () => {
    await unprioritize()
    await sync()
    await saveRules(RULES)
    expect(await calendarUids()).toEqual([ROUNDTABLE])
    await getDb(env.DB).update(bills).set({ priority: 'high' }).where(eq(bills.id, billId))
    // The event that covers it is still hidden, so the bill's own entry shows.
    expect(await calendarUids()).toEqual([ROUNDTABLE, HEARING_UID].sort())
    await sync()
    expect(await calendarUids()).toEqual([ROUNDTABLE, STADIUM].sort())
  })

  it('select by kind or event type, topic, and tracked bills', async () => {
    await unprioritize()
    await sync()
    await saveRules({ committees: [], kinds: ['Meeting'], topics: [], trackedBills: false })
    expect(await calendarUids()).toEqual([MEETING])
    await saveRules({ committees: [], kinds: ['roundtable'], topics: [], trackedBills: false })
    expect(await calendarUids()).toEqual([ROUNDTABLE])
    await saveRules({ committees: [], kinds: [], topics: [{ name: 'Housing agencies', keywords: ['housing authority'] }], trackedBills: false })
    expect(await calendarUids()).toEqual([ROUNDTABLE])
    await saveRules({ committees: [], kinds: [], topics: [], trackedBills: true })
    expect(await calendarUids()).toEqual([STADIUM])
    await saveRules({ committees: [{ ...COW, kind: 'meeting' }], kinds: [], topics: [], trackedBills: false })
    expect(await calendarUids()).toEqual([])
  })

  it('apply to events that arrive later, on the hourly sync', async () => {
    await sync()
    await saveRules(RULES)
    central.events = [...central.events, bodyEvent({ uid: 'council-2500@lims.dccouncil.gov', date: isoDay(6), eventHash: 'e4' }),
      bodyEvent({ uid: 'council-2501@lims.dccouncil.gov', committee: COW, date: isoDay(6), eventHash: 'e5' })]
    await sync()
    expect(await calendarUids()).toEqual([ROUNDTABLE, STADIUM, 'council-2500@lims.dccouncil.gov'].sort())
  })

  it('leave no event hidden once cleared, even while central is down', async () => {
    await sync()
    await saveRules(RULES)
    central.status = 503
    const res = await saveRules(null)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rules: null, shown: 3, hidden: 0 })
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
    const rows = await getDb(env.DB).select({ ruleMatch: calendarEvents.ruleMatch }).from(calendarEvents).where(eq(calendarEvents.source, 'body')).all()
    expect(rows.every(r => r.ruleMatch === null)).toBe(true)
    expect(await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'event_rules')).get()).toBeUndefined()
    // And a failed sync after clearing changes nothing.
    await expect(sync()).rejects.toThrow()
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
  })

  it('carry a fork team\'s DC Council calendar rules over, and save them as its event rules', async () => {
    await getDb(env.DB).insert(associationConfig).values({ key: 'council_calendar_rules', value: JSON.stringify({
      include: [{ committee: 'Housing' }, { committee: 'Legislative Meeting' }], types: [], topicKeywords: [], trackedBills: false,
    }) })
    await sync()
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
    const saved = await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'event_rules')).get()
    expect(JSON.parse(saved!.value)).toEqual({
      committees: [HOUSING], kinds: [], topics: [{ name: COUNCIL_CALENDAR_TOPIC, keywords: ['legislative meeting'] }], trackedBills: false,
    })
    expect(((await (await api('/admin/event-rules')).json()) as any).rules).toEqual(JSON.parse(saved!.value))

    // Clearing drops both, so the fork's rules don't come back.
    await saveRules(null)
    await sync()
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
    expect(await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'council_calendar_rules')).get()).toBeUndefined()
  })

  it('carry a fork team\'s rules over only once central\'s committee list arrives', async () => {
    await getDb(env.DB).insert(associationConfig).values({ key: 'council_calendar_rules', value: JSON.stringify({
      include: [{ committee: 'Health' }], types: [], topicKeywords: [], trackedBills: false,
    }) })
    const savedRules = () => getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'event_rules')).get()
    central.optionsStatus = 503
    await sync()
    // Without the list, "Health" (whose committee holds no event yet) would become a keyword, so nothing is saved or applied.
    expect(await savedRules()).toBeUndefined()
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
    const rows = await getDb(env.DB).select({ ruleMatch: calendarEvents.ruleMatch }).from(calendarEvents).where(eq(calendarEvents.source, 'body')).all()
    expect(rows.every(r => r.ruleMatch === null)).toBe(true)

    // The settings page shows the carry-over meanwhile, without saving it.
    const page = await (await api('/admin/event-rules')).json() as any
    expect(page.optionsError).toMatch(/unavailable/)
    expect(page.rules).toMatchObject({ committees: [], topics: [{ name: COUNCIL_CALENDAR_TOPIC, keywords: ['health'] }] })
    expect(await savedRules()).toBeUndefined()

    // The next hour, central answers.
    delete central.optionsStatus
    await sync()
    expect(JSON.parse((await savedRules())!.value)).toEqual({
      committees: [{ committeeId: '3000000003', name: 'Committee on Health' }], kinds: [], topics: [], trackedBills: false,
    })
    expect(await calendarUids()).toEqual([STADIUM])
  })

  it('carry a fork team\'s rules over only once some committee is known, though central answers', async () => {
    await getDb(env.DB).insert(associationConfig).values({ key: 'council_calendar_rules', value: JSON.stringify({ include: [{ committee: 'Health' }] }) })
    const savedRules = () => getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'event_rules')).get()
    // Central lists no committees, and the instance's only event has none.
    central.events = [legislativeMeeting()]
    central.optionsStates = {}
    await sync()
    expect(await savedRules()).toBeUndefined()
    expect(await calendarUids()).toEqual([MEETING, HEARING_UID].sort())

    delete central.optionsStates
    await sync()
    expect(JSON.parse((await savedRules())!.value).committees).toEqual([{ committeeId: '3000000003', name: 'Committee on Health' }])
    expect(await calendarUids()).toEqual([HEARING_UID])
  })

  it('leave a fork team\'s rules alone while no covered state has body events', async () => {
    await getDb(env.DB).insert(associationConfig).values({ key: 'council_calendar_rules', value: JSON.stringify({ include: [{ committee: 'Health' }] }) })
    central.bodyEvents = false
    central.events = []
    await sync()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/body-event-options'))).toBe(false)
    expect(await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'event_rules')).get()).toBeUndefined()
  })

  it('apply a fork team\'s rules at once when the settings page carries them over', async () => {
    await getDb(env.DB).insert(associationConfig).values({ key: 'council_calendar_rules', value: JSON.stringify({ include: [{ committee: 'Housing' }] }) })
    central.optionsStatus = 503
    await sync()
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
    delete central.optionsStatus
    const page = await (await api('/admin/event-rules')).json() as any
    expect(page.rules.committees).toEqual([HOUSING])
    // No sync since: the page's save applied them.
    expect(await calendarUids()).toEqual([ROUNDTABLE, STADIUM].sort())
  })

  it('refuse malformed rules and members', async () => {
    expect((await saveRules({ committees: [{ committeeId: '1' }] })).status).toBe(400)
    expect((await api('/admin/event-rules', { method: 'PUT', body: '{}' })).status).toBe(400)
    expect((await saveRules(RULES, member)).status).toBe(403)
    expect((await api('/admin/event-rules', {}, member)).status).toBe(403)
  })

  it('still list choices when central is down', async () => {
    await sync()
    await saveRules({ ...RULES, committees: [HOUSING, { committeeId: '999', name: 'Committee on Gone' }] })
    central.status = 503
    const body = await (await api('/admin/event-rules')).json() as any
    expect(body.optionsError).toMatch(/unavailable/)
    expect(body.committees.map((c: any) => c.name).sort()).toEqual(['Committee of the Whole', 'Committee on Gone', 'Committee on Housing'])
    expect(body.kinds).toEqual([{ kind: 'hearing', types: ['Hearing', 'Roundtable'] }, { kind: 'meeting', types: ['Meeting'] }])
  })
})

describe('the week-ahead email', () => {
  beforeEach(async () => {
    const weekday = String(new Date().getUTCDay())
    await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
  })

  const emailed = () => {
    const call = sendBatch.mock.calls.at(-1) as unknown as [unknown, { html: string }[]] | undefined
    return call?.[1][0].html ?? ''
  }

  it('lists every body event the calendar shows while there are no rules (All events)', async () => {
    await sync()
    await runWeekAhead(env as any, getDb(env.DB))
    expect(emailed()).toContain('Committee of the Whole hearing')
    expect(emailed()).toContain('Housing roundtable')
    expect(emailed()).toContain('Legislative Meeting')
  })

  it('lists the body events the rules select, and still a prioritized bill\'s', async () => {
    await sync()
    await saveRules(RULES)
    await runWeekAhead(env as any, getDb(env.DB))
    expect(emailed()).toContain('Housing roundtable')
    expect(emailed()).toContain('Committee of the Whole hearing')
    expect(emailed()).not.toContain('Legislative Meeting')
  })
})

describe('the week-ahead email and the calendar, under the Calendar page\'s one control (#420)', () => {
  const TITLES: Record<string, string> = { [ROUNDTABLE]: 'Housing roundtable', [STADIUM]: 'Committee of the Whole hearing', [MEETING]: 'Legislative Meeting' }

  beforeEach(async () => {
    const weekday = String(new Date().getUTCDay())
    await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
  })

  // The control saves committees and nothing else. A rule saved earlier may also carry kinds, event types, topics, or tracked bills.
  it.each([
    ['no rules at all (All events)', null],
    ['one committee', { committees: [HOUSING], kinds: [], topics: [], trackedBills: false }],
    ['two committees', { committees: [HOUSING, COW], kinds: [], topics: [], trackedBills: false }],
    ['no committees chosen', { committees: [], kinds: [], topics: [], trackedBills: false }],
    ['a rule saved earlier with a kind', { committees: [HOUSING], kinds: ['Meeting'], topics: [], trackedBills: false }],
    ['a rule saved earlier with an event type', { committees: [], kinds: ['roundtable'], topics: [], trackedBills: false }],
    ['a rule saved earlier with a topic', { committees: [], kinds: [], topics: [{ name: 'Housing agencies', keywords: ['housing authority'] }], trackedBills: false }],
    ['a rule saved earlier with tracked bills', { committees: [], kinds: [], topics: [], trackedBills: true }],
    ['a rule saved earlier with a committee narrowed to a kind', { committees: [{ ...HOUSING, kind: 'Roundtable' }, { ...COW, kind: 'meeting' }], kinds: [], topics: [], trackedBills: false }],
  ])('list the same body events in the email as the calendar shows: %s', async (_name, rules) => {
    await sync()
    if (rules) await saveRules(rules)
    const shown = (await calendarUids()).filter(uid => uid in TITLES)
    await runWeekAhead(env as any, getDb(env.DB))
    const call = sendBatch.mock.calls.at(-1) as unknown as [unknown, { html: string }[]] | undefined
    const html = call?.[1][0].html ?? ''
    for (const [uid, title] of Object.entries(TITLES)) expect(html.includes(title), `${title}: calendar ${shown.includes(uid) ? 'shows' : 'hides'} it`).toBe(shown.includes(uid))
  })

  it('follow the same rule in the calendar feed', async () => {
    await sync()
    await saveRules({ committees: [HOUSING], kinds: [], topics: [], trackedBills: false })
    const shown = await calendarUids()
    const ics = await feed()
    for (const uid of Object.keys(TITLES)) expect(ics.includes(`UID:${uid}`)).toBe(shown.includes(uid))
  })

  it('an instance with no rules shows every body event on the calendar, in the feed, and in the email', async () => {
    await sync()
    expect((await calendarUids()).filter(uid => uid in TITLES)).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
    const ics = await feed()
    for (const uid of Object.keys(TITLES)) expect(ics).toContain(`UID:${uid}`)
    await runWeekAhead(env as any, getDb(env.DB))
    const call = sendBatch.mock.calls.at(-1) as unknown as [unknown, { html: string }[]] | undefined
    const html = call?.[1][0].html ?? ''
    for (const title of Object.values(TITLES)) expect(html).toContain(title)
  })

  it('clearing the rules puts every body event back in the email too', async () => {
    await sync()
    await saveRules({ committees: [HOUSING], kinds: [], topics: [], trackedBills: false })
    await saveRules(null)
    await runWeekAhead(env as any, getDb(env.DB))
    const call = sendBatch.mock.calls.at(-1) as unknown as [unknown, { html: string }[]] | undefined
    const html = call?.[1][0].html ?? ''
    for (const title of Object.values(TITLES)) expect(html).toContain(title)
  })

  it('past the 30-event cap, the email lists what it can and counts the rest, so listed plus left out is what the calendar shows (#675)', async () => {
    await sync()
    const db = getDb(env.DB)
    for (let i = 0; i < 40; i++) {
      await db.insert(calendarEvents).values({ id: `cap-${i}`, uid: `cap-${i}@test`, billId: null, source: 'body', sequence: 0, date: isoDay(1 + (i % 5)), time: `${String(8 + Math.floor(i / 5)).padStart(2, '0')}:00:00`, description: `Capped week event ${i} end`, status: 'confirmed', ruleMatch: null })
    }
    const shown = (await calendarUids()).filter(uid => uid in TITLES || uid.startsWith('cap-'))
    await runWeekAhead(env as any, getDb(env.DB))
    const call = sendBatch.mock.calls.at(-1) as unknown as [unknown, { html: string }[]] | undefined
    const html = call?.[1][0].html ?? ''
    const listedCount = Array.from(html.matchAll(/Capped week event \d+ end|Housing roundtable|Committee of the Whole hearing|Legislative Meeting/g)).length
    const omitted = Number(html.match(/and (\d+) more on the calendar/)?.[1])
    expect(shown).toHaveLength(43)
    expect(listedCount + omitted).toBe(shown.length)
    expect(omitted).toBeGreaterThan(0)
  })

  it('refuses a member the rules: only an admin changes which events show', async () => {
    await sync()
    expect((await saveRules({ committees: [HOUSING], kinds: [], topics: [], trackedBills: false }, member)).status).toBe(403)
    expect((await api('/admin/event-rules', {}, member)).status).toBe(403)
    expect(await calendarUids()).toEqual([ROUNDTABLE, MEETING, STADIUM].sort())
  })
})

describe('deadlines', () => {
  it('show on the calendar and feed for prioritized bills only, as hearings do', async () => {
    const tracked = await seedBill({ billNumber: 'B26-0100', state: 'DC', priority: null, matchType: 'keyword', externalId: 'legiscan:1' })
    await seedCalendarEvent(billId, { uid: 'deadline-1@test', kind: 'deadline', date: isoDay(8), description: 'Mayor\'s response due' })
    await seedCalendarEvent(tracked, { uid: 'deadline-2@test', kind: 'deadline', date: isoDay(8), description: 'Mayor\'s response due' })
    await seedCalendarEvent(tracked, { uid: 'hearing-2@test', kind: 'hearing', date: isoDay(8), description: 'Public Hearing on B26-0100' })
    const uids = await calendarUids()
    expect(uids).toContain('deadline-1@test')
    expect(uids).not.toContain('deadline-2@test')
    expect(uids).not.toContain('hearing-2@test')
    const ics = await feed()
    expect(ics).toContain('UID:deadline-1@test')
    expect(ics).not.toContain('UID:deadline-2@test')
  })
})
