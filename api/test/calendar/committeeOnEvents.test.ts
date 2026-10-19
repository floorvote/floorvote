import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { syncBodyEvents, type CentralBodyEvent } from '../../src/lib/bodyEvents'
import { hearingUid } from '../../src/lib/hearingUid'

// The committee on every body event (#695): GET /calendar/events carries each
// body event's committee, joint committee, and state from its stored
// rule_facets, null for every other event, and says when a prioritized bill is
// the only reason the event shows. Central's answers are stubbed.

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const HANDLE = 'legiscan:1012600769'
const IDENTITY = 'hearing|2026-10-23|public hearing on b26-0769'
const HEARING_UID = hearingUid(HANDLE, IDENTITY, 'bpc-test')
const HOUSING = { committeeId: '3000000001', name: 'Committee on Housing' }
const HEALTH = { committeeId: '3000000003', name: 'Committee on Health' }
const COW = { committeeId: '3000000002', name: 'Committee of the Whole' }
const FINANCE = { committeeId: '4000000001', name: 'Senate Finance Committee' }

function bodyEvent(o: Partial<CentralBodyEvent> = {}): CentralBodyEvent {
  return {
    uid: 'council-housing@example.test', state: 'DC', kind: 'hearing', type: 'Roundtable',
    date: isoDay(2), time: '10:00', timezone: 'America/New_York',
    committee: HOUSING, jointWith: null, location: 'Room 123', title: 'Housing roundtable',
    agenda: [], url: null, eventHash: 'h1', cancelled: false, bills: [], covers: [], ...o,
  }
}
const joint = () => bodyEvent({ uid: 'council-joint@example.test', committee: HEALTH, jointWith: 'Committee on Housing', title: 'Joint hearing', eventHash: 'h2', date: isoDay(3) })
const noCommittee = () => bodyEvent({ uid: 'council-meeting@example.test', kind: 'meeting', type: 'Meeting', committee: null, title: 'Legislative Meeting', eventHash: 'h3', date: isoDay(4) })
const wholeWithPrioritized = () => bodyEvent({
  uid: 'council-cow@example.test', type: 'Hearing', date: isoDay(5), committee: COW, title: 'Whole hearing', eventHash: 'h4',
  agenda: [{ topic: 'Stadium Act', billNumber: 'B26-0769' }], bills: [HANDLE], covers: [{ billId: HANDLE, identityKey: IDENTITY }],
})
const otherState = () => bodyEvent({ uid: 'senate-finance@example.test', state: 'MD', committee: FINANCE, title: 'Finance hearing', eventHash: 'h5', date: isoDay(6) })

let central: { events: CentralBodyEvent[] }
const fetchMock = vi.fn()
let admin: string
let billId: string

beforeEach(async () => {
  await clearDb()
  admin = await seedSession(await seedUser({ role: 'admin', email: 'admin@b.com' }))
  const db = getDb(env.DB)
  await db.insert(associationConfig).values({ key: 'state_coverage', value: '["DC","MD"]' })
  billId = await seedBill({ billNumber: 'B26-0769', state: 'DC', priority: 'high', externalId: HANDLE })
  await seedCalendarEvent(billId, { uid: HEARING_UID, kind: 'hearing', date: isoDay(5), time: '', location: '', description: 'Public Hearing on B26-0769' })
  central = { events: [bodyEvent(), joint(), noCommittee(), wholeWithPrioritized(), otherState()] }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (String(url).startsWith('https://central.test/api/tenants/bpc-test/body-events?')) {
      return json({ capabilities: { DC: { bodyEvents: true, deadlines: true }, MD: { bodyEvents: true, deadlines: true } }, events: central.events })
    }
    if (String(url) === 'https://central.test/api/tenants/bpc-test/body-event-options') {
      return json({ states: {
        DC: { committees: [{ ...COW, chamber: 'C' }, { ...HOUSING, chamber: 'C' }, { ...HEALTH, chamber: 'C' }], kinds: [] },
        MD: { committees: [{ ...FINANCE, chamber: 'S' }], kinds: [] },
      } })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.unstubAllGlobals() })

const sync = () => syncBodyEvents(env as any, getDb(env.DB))
async function api(path: string, init: RequestInit = {}) {
  return SELF.fetch(`http://localhost/api${path}`, { ...init, headers: { Cookie: `session=${admin}`, 'content-type': 'application/json' } })
}
const saveRules = (rules: unknown) => api('/admin/event-rules', { method: 'PUT', body: JSON.stringify({ rules }) })
async function events() {
  const res = await api(`/calendar/events?from=${isoDay(-30)}&to=${isoDay(60)}`)
  expect(res.status).toBe(200)
  return (await res.json()) as any[]
}
const byTitle = (list: any[], title: string) => list.find(e => e.description === title || e.description?.startsWith(`${title}:`))

describe('GET /calendar/events carries the committee (#695)', () => {
  it('names a body event\'s committee, its id, and its state', async () => {
    await sync()
    expect(byTitle(await events(), 'Housing roundtable')).toMatchObject({ committee: HOUSING.name, committeeId: HOUSING.committeeId, jointWith: null, bodyState: 'DC' })
  })

  it('names the joint committee of a joint committee meeting', async () => {
    await sync()
    expect(byTitle(await events(), 'Joint hearing')).toMatchObject({ committee: HEALTH.name, jointWith: 'Committee on Housing' })
  })

  it('sends null committee and jointWith for a body event with no committee, which still names its state', async () => {
    await sync()
    const e = byTitle(await events(), 'Legislative Meeting')
    expect(e).toMatchObject({ source: 'body', committee: null, committeeId: null, jointWith: null, bodyState: 'DC' })
  })

  it('tells the states apart', async () => {
    await sync()
    expect(byTitle(await events(), 'Finance hearing')).toMatchObject({ committee: FINANCE.name, bodyState: 'MD' })
  })

  it('sends null for events that are not body events: custom events and a bill\'s own hearing', async () => {
    await sync()
    const custom = await api('/calendar/events', { method: 'POST', body: JSON.stringify({ description: 'Board meeting', date: isoDay(7) }) })
    expect([200, 201]).toContain(custom.status)
    const list = await events()
    const mine = list.find(e => e.description === 'Board meeting')
    expect(mine).toMatchObject({ source: 'custom', committee: null, committeeId: null, jointWith: null, bodyState: null, shownByPriority: false })
    const hearing = list.filter(e => e.source === 'hearing')
    for (const h of hearing) expect(h).toMatchObject({ committee: null, jointWith: null, bodyState: null })
  })
})

describe('the "Shown: prioritized bill" flag (#695)', () => {
  it('is false for every event while the instance has no rules', async () => {
    await sync()
    for (const e of await events()) expect(e.shownByPriority).toBe(false)
  })

  it('is true for a prioritized-bill event under a committee the rules hide, and only that one', async () => {
    await sync()
    expect((await saveRules({ committees: [HOUSING], kinds: [], topics: [], trackedBills: false })).status).toBe(200)
    const list = await events()
    expect(byTitle(list, 'Whole hearing')).toMatchObject({ committee: COW.name, shownByPriority: true })
    expect(byTitle(list, 'Housing roundtable').shownByPriority).toBe(false)
    expect(byTitle(list, 'Legislative Meeting')).toBeUndefined()
  })

  it('is false once the rules select that committee', async () => {
    await sync()
    await saveRules({ committees: [COW], kinds: [], topics: [], trackedBills: false })
    expect(byTitle(await events(), 'Whole hearing').shownByPriority).toBe(false)
  })

  it('is true for a prioritized-bill event with no committee that the rules hide', async () => {
    central.events = [bodyEvent({ uid: 'council-whole-meeting@example.test', committee: null, title: 'Open meeting', eventHash: 'h6', agenda: [{ topic: 'Stadium Act', billNumber: 'B26-0769' }], bills: [HANDLE], covers: [] })]
    await sync()
    await saveRules({ committees: [HOUSING], kinds: [], topics: [], trackedBills: false })
    expect(byTitle(await events(), 'Open meeting')).toMatchObject({ committee: null, shownByPriority: true })
  })
})

describe('a fork\'s unsettled carry-over rules (#695)', () => {
  it('flag no event as shown by a prioritized bill, since they are provisional and not applied', async () => {
    await sync()
    await getDb(env.DB).insert(associationConfig).values({ key: 'council_calendar_rules', value: JSON.stringify({ include: [{ committee: 'Committee on Housing' }] }) })
    fetchMock.mockImplementation(async () => new Response('down', { status: 500 }))
    for (const e of await events()) expect(e.shownByPriority).toBe(false)
  })
})

describe('rules per state (#695)', () => {
  it('keep every event of a state in allStates, and apply committees to the others', async () => {
    await sync()
    const res = await saveRules({ committees: [HOUSING], kinds: [], topics: [], trackedBills: false, allStates: ['MD'] })
    expect(res.status).toBe(200)
    const titles = (await events()).filter(e => e.source === 'body').map(e => e.description).sort()
    expect(titles).toEqual(['Finance hearing', 'Housing roundtable', 'Joint hearing', 'Whole hearing: Stadium Act'].sort())
  })

  it('hide a state\'s events when it is neither in allStates nor has a chosen committee', async () => {
    await sync()
    await saveRules({ committees: [FINANCE], kinds: [], topics: [], trackedBills: false })
    const titles = (await events()).filter(e => e.source === 'body').map(e => e.description).sort()
    expect(titles).toEqual(['Finance hearing', 'Whole hearing: Stadium Act'].sort())
  })

  it('refuse allStates values that are not two-letter uppercase state codes', async () => {
    for (const bad of ['dc', 'DCX', 'D', 'Maryland']) {
      expect((await saveRules({ committees: [], allStates: [bad] })).status).toBe(400)
    }
  })

  it('refuse allStates that is not a list', async () => {
    expect((await saveRules({ committees: [], allStates: 'MD' })).status).toBe(400)
  })

  it('read back the saved allStates', async () => {
    await sync()
    await saveRules({ committees: [], kinds: [], topics: [], trackedBills: false, allStates: ['MD'] })
    const body = await (await api('/admin/event-rules')).json() as any
    expect(body.rules.allStates).toEqual(['MD'])
    expect(body.events.find((e: any) => e.facets.title === 'Finance hearing').facets.state).toBe('MD')
  })
})
