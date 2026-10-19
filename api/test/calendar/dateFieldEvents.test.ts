import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, billCustomFieldValues, bills, customFieldDefinitions } from '../../src/db/schema'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { resetMail, lastBatch } from '../mail'

// A date custom field on a prioritized bill is a team's own dated commitment, and
// shows on the calendar, in the feed, in the dashboard count, and in the
// week-ahead email as a `field` event projected at read time (#342).

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

type EventRow = {
  id: string; uid: string; source: string; kind: string | null; billId: string | null
  date: string | null; time: string | null; description: string | null; status: string
  fieldName?: string | null
  bills: { id: string; billNumber: string; state: string | null; priority: string | null; isDraft: boolean }[]
}

let userId: string
let token: string

beforeEach(async () => {
  await clearDb()
  userId = await seedUser({ email: 'a@b.com', role: 'admin' })
  token = await seedSession(userId)
  resetMail()
})

async function addField(id: string, name: string, type = 'date') {
  await getDb(env.DB).insert(customFieldDefinitions).values({ id, name, type, displayOrder: 0 })
}

async function setValue(billId: string, fieldId: string, value: string, updatedAt?: string) {
  await getDb(env.DB).insert(billCustomFieldValues)
    .values({ billId, fieldId, value, setBy: userId, ...(updatedAt ? { updatedAt } : {}) })
    .onConflictDoUpdate({
      target: [billCustomFieldValues.billId, billCustomFieldValues.fieldId],
      set: { value, ...(updatedAt ? { updatedAt } : {}) },
    })
}

async function events(query = ''): Promise<EventRow[]> {
  const r = await SELF.fetch(`http://localhost/api/calendar/events${query}`, { headers: { Cookie: `session=${token}` } })
  expect(r.status).toBe(200)
  return await r.json() as EventRow[]
}

const fieldEvents = async (query = '') => (await events(query)).filter(e => e.source === 'field')

async function feed(): Promise<string> {
  const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: `session=${token}` } })).json() as { slug: string }
  const r = await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)
  expect(r.status).toBe(200)
  return (await r.text()).replace(/\r\n /g, '')
}

/** The VEVENT block carrying this UID, unfolded. */
const vevent = (ics: string, uid: string) => ics.split('BEGIN:VEVENT').find(b => b.includes(`UID:${uid}`))

async function upcomingCount(): Promise<number> {
  const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
  return (await r.json() as { calendarUpcomingCount: number }).calendarUpcomingCount
}

describe('GET /api/calendar/events, for date custom fields', () => {
  it('shows an all-day event on a prioritized bill, titled "{field name}: {bill number}"', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', state: 'DC', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(bill, 'f1', isoDay(5))

    expect(await fieldEvents()).toEqual([{
      id: `cf-f1-${bill}`, uid: `cf-f1-${bill}`, source: 'field', kind: null, billId: bill,
      eventHash: null, eventHashes: [],
      date: isoDay(5), time: null, location: null,
      description: 'Comment deadline: HB 12', details: null, url: null,
      status: 'confirmed', fieldName: 'Comment deadline',
      committee: null, committeeId: null, jointWith: null, bodyState: null, shownByPriority: false,
      bills: [{ id: bill, billNumber: 'HB 12', billTitle: 'Test Bill', state: 'DC', priority: 'high', isDraft: false }],
    }])
  })

  it('leaves out an unprioritized bill\'s date', async () => {
    const plain = await seedBill({ billNumber: 'HB 13', state: 'DC', priority: null })
    const prio = await seedBill({ billNumber: 'HB 14', state: 'DC', priority: 'low', externalId: 'legiscan:14' })
    await addField('f1', 'Comment deadline')
    await setValue(plain, 'f1', isoDay(5))
    await setValue(prio, 'f1', isoDay(5))
    expect((await fieldEvents()).map(e => e.description)).toEqual(['Comment deadline: HB 14'])
  })

  it('makes two events for two date fields on one bill, and one per bill for one field on two bills', async () => {
    const a = await seedBill({ billNumber: 'HB 1', priority: 'high' })
    const b = await seedBill({ billNumber: 'HB 2', priority: 'low' })
    await addField('f1', 'Comment deadline')
    await addField('f2', 'Board vote')
    await setValue(a, 'f1', isoDay(3))
    await setValue(a, 'f2', isoDay(4))
    await setValue(b, 'f1', isoDay(3))

    const rows = await fieldEvents()
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(e => e.id)).size).toBe(3)
    expect(rows.map(e => e.description).sort()).toEqual(['Board vote: HB 1', 'Comment deadline: HB 1', 'Comment deadline: HB 2'])
    expect(rows.every(e => e.bills.length === 1)).toBe(true)
  })

  it('includes values on both boundary dates and excludes values outside', async () => {
    const bill = await seedBill({ priority: 'high' })
    for (const [i, offset] of [-11, -10, 10, 11].entries()) {
      await addField(`f${i}`, `Field ${i}`)
      await setValue(bill, `f${i}`, isoDay(offset))
    }
    const rows = await fieldEvents(`?from=${isoDay(-10)}&to=${isoDay(10)}`)
    expect(rows.map(e => e.date).sort()).toEqual([isoDay(-10), isoDay(10)])
  })

  it('skips a value that is not a YYYY-MM-DD date, without an error', async () => {
    const bill = await seedBill({ priority: 'high' })
    const bad = ['next Tuesday', '2026-13-45', '2026-02-30', '2026-6-4', `${isoDay(2)} 10:00`]
    for (const [i, v] of bad.entries()) {
      await addField(`f${i}`, `Field ${i}`)
      await setValue(bill, `f${i}`, v)
    }
    await addField('good', 'Good field')
    await setValue(bill, 'good', isoDay(2))
    // The window is wide so only the shape check can leave the bad ones out.
    expect((await fieldEvents('?from=0000-01-01&to=9999-12-31')).map(e => e.fieldName)).toEqual(['Good field'])
  })

  it('takes an event off the calendar when the value is cleared, the field is deleted, or the bill loses its priority', async () => {
    const db = getDb(env.DB)
    const a = await seedBill({ billNumber: 'HB 1', priority: 'high' })
    const b = await seedBill({ billNumber: 'HB 2', priority: 'high' })
    const c = await seedBill({ billNumber: 'HB 3', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await addField('f2', 'Board vote')
    await setValue(a, 'f1', isoDay(3))
    await setValue(b, 'f1', isoDay(3))
    await setValue(c, 'f1', isoDay(3))
    await setValue(a, 'f2', isoDay(3))
    expect(await fieldEvents()).toHaveLength(4)

    await db.delete(billCustomFieldValues).where(and(eq(billCustomFieldValues.billId, a), eq(billCustomFieldValues.fieldId, 'f1')))
    expect((await fieldEvents()).map(e => e.id)).not.toContain(`cf-f1-${a}`)

    await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, 'f2'))
    expect((await fieldEvents()).map(e => e.fieldName)).toEqual(['Comment deadline', 'Comment deadline'])

    await db.update(bills).set({ priority: null }).where(eq(bills.id, b))
    expect((await fieldEvents()).map(e => e.billId)).toEqual([c])
  })

  it('never merges with a hearing or a body event, and leaves hearings merging as before', async () => {
    const a = await seedBill({ billNumber: 'HB 1', priority: 'high', externalId: 'legiscan:1' })
    const b = await seedBill({ billNumber: 'HB 2', priority: 'high', externalId: 'legiscan:2' })
    await addField('f1', 'Comment deadline')
    await setValue(a, 'f1', isoDay(3))
    const meeting = { kind: 'hearing', date: isoDay(3), time: '10:00:00', location: 'Room 1', description: 'Comment deadline: HB 1' }
    await seedCalendarEvent(a, { ...meeting, uid: 'h-a@t', eventHash: 'ha' })
    await seedCalendarEvent(b, { ...meeting, uid: 'h-b@t', eventHash: 'hb' })

    const rows = await events()
    expect(rows.filter(e => e.source === 'field')).toHaveLength(1)
    const hearings = rows.filter(e => e.source === 'hearing')
    expect(hearings).toHaveLength(1)
    expect(hearings[0].bills.map(x => x.billNumber).sort()).toEqual(['HB 1', 'HB 2'])
  })

  it('flags a draft bill\'s event as a draft, and follows the bill when the draft is linked to a filed bill', async () => {
    const draft = await seedBill({ billNumber: 'Draft 1', priority: 'high', isDraft: true })
    const filed = await seedBill({ billNumber: 'HB 9', priority: 'high', externalId: 'legiscan:9' })
    await addField('f1', 'Comment deadline')
    await setValue(draft, 'f1', isoDay(3))
    expect((await fieldEvents()).map(e => e.bills[0])).toEqual([expect.objectContaining({ id: draft, isDraft: true })])

    const link = await SELF.fetch(`https://x/api/bills/${draft}/link`, {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filedBillId: filed }),
    })
    expect(link.status).toBe(200)
    const rows = await fieldEvents()
    expect(rows).toEqual([expect.objectContaining({
      id: `cf-f1-${filed}`, description: 'Comment deadline: HB 9',
      bills: [expect.objectContaining({ id: filed, isDraft: false })],
    })])
  })

  it('ignores yes/no, dropdown, and text fields, even with a date-shaped value', async () => {
    const bill = await seedBill({ priority: 'high' })
    await addField('f-bin', 'Reviewed', 'binary')
    await addField('f-drop', 'Stage', 'dropdown')
    await addField('f-text', 'Notes', 'text')
    await setValue(bill, 'f-bin', '1')
    await setValue(bill, 'f-drop', isoDay(2))
    await setValue(bill, 'f-text', isoDay(2))
    await addField('f-date', 'Board vote')
    await setValue(bill, 'f-date', isoDay(2))
    expect((await fieldEvents()).map(e => e.fieldName)).toEqual(['Board vote'])
    expect(await upcomingCount()).toBe(1)
    const ics = await feed()
    expect(ics).toContain('Board vote')
    expect(ics).not.toContain('Notes')
    expect(ics).not.toContain('Stage')
  })
})

describe('a date-field event, for an admin', () => {
  it('refuses edit, delete, and restore on its id', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(bill, 'f1', isoDay(5))
    const id = `cf-f1-${bill}`
    const call = (method: string, path = '') => SELF.fetch(`http://localhost/api/calendar/events/${id}${path}`, {
      method,
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: method === 'PUT' ? JSON.stringify({ description: 'Moved', date: isoDay(9) }) : undefined,
    })
    expect((await call('PUT')).status).toBe(404)
    expect((await call('DELETE')).status).toBe(404)
    expect((await call('POST', '/restore')).status).toBe(404)
    expect((await fieldEvents()).map(e => ({ id: e.id, date: e.date }))).toEqual([{ id, date: isoDay(5) }])
  })
})

describe('the calendar feed, for date custom fields', () => {
  it('lists a date-only event titled as on the calendar, with a UID that is the same on every fetch', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', state: 'DC', session: '2026', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(bill, 'f1', isoDay(5))

    const first = vevent(await feed(), `cf-f1-${bill}`)
    expect(first).toBeDefined()
    expect(first).toContain(`DTSTART;VALUE=DATE:${isoDay(5).replace(/-/g, '')}`)
    expect(first).not.toContain('DTEND')
    expect(first).toMatch(/\r\nSUMMARY:Comment deadline: HB 12\r\n/)
    expect(first).toContain('STATUS:CONFIRMED')
    expect(vevent(await feed(), `cf-f1-${bill}`)).toBeDefined()
  })

  it('leaves out an unprioritized bill\'s date, and a value before the look-back window', async () => {
    const plain = await seedBill({ billNumber: 'HB 1', priority: null })
    const old = await seedBill({ billNumber: 'HB 2', priority: 'high' })
    const recent = await seedBill({ billNumber: 'HB 3', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(plain, 'f1', isoDay(3))
    await setValue(old, 'f1', isoDay(-8))
    await setValue(recent, 'f1', isoDay(-7))
    const ics = await feed()
    expect(ics).not.toContain(`cf-f1-${plain}`)
    expect(ics).not.toContain(`cf-f1-${old}`)
    expect(ics).toContain(`UID:cf-f1-${recent}`)
  })

  it('keeps the UID when the date changes, and increases the sequence', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(bill, 'f1', isoDay(5), '2026-03-01 12:30:45')
    const before = vevent(await feed(), `cf-f1-${bill}`)!
    await setValue(bill, 'f1', isoDay(6), '2026-03-01 12:31:00')
    const after = vevent(await feed(), `cf-f1-${bill}`)!
    expect(before).toBeDefined()
    expect(after).toBeDefined()

    const seq = (v: string) => Number(/SEQUENCE:(\d+)/.exec(v)![1])
    expect(after).toContain(`DTSTART;VALUE=DATE:${isoDay(6).replace(/-/g, '')}`)
    expect(seq(after)).toBeGreaterThan(seq(before))
    // Whole minutes since 2020-01-01 UTC.
    expect(seq(before)).toBe(Math.floor((Date.UTC(2026, 2, 1, 12, 30, 45) - Date.UTC(2020, 0, 1)) / 60_000))
    expect(Number.isInteger(seq(after)) && seq(after) >= 0 && seq(after) < 2 ** 31).toBe(true)
  })

  it('links the event to the bill page', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', state: 'DC', session: '2026', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(bill, 'f1', isoDay(5))
    const block = vevent(await feed(), `cf-f1-${bill}`)!
    expect(block).toBeDefined()
    expect(block).toContain('URL:https://localhost/DC/2026/HB%2012')
    expect(block).toContain('Set from the Comment deadline field on HB 12')
  })
})

describe('GET /api/stats, for date custom fields', () => {
  it('counts date-field events in the 30-day window, as the calendar shows them', async () => {
    const prio = await seedBill({ billNumber: 'HB 1', priority: 'high' })
    const plain = await seedBill({ billNumber: 'HB 2', priority: null })
    await addField('f1', 'Comment deadline')
    await addField('f2', 'Board vote')
    await setValue(prio, 'f1', isoDay(5))
    await setValue(prio, 'f2', isoDay(40))
    await setValue(plain, 'f1', isoDay(5))
    expect(await upcomingCount()).toBe(1)
  })

  it('leaves out a malformed value', async () => {
    const prio = await seedBill({ billNumber: 'HB 1', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await addField('f2', 'Board vote')
    await setValue(prio, 'f1', 'soon')
    await setValue(prio, 'f2', isoDay(3))
    expect(await upcomingCount()).toBe(1)
  })
})

describe('the week-ahead email, for date custom fields', () => {
  beforeEach(async () => {
    const weekday = String(new Date().getUTCDay())
    await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
  })

  async function emailed(): Promise<string> {
    await runWeekAhead(env as any, getDb(env.DB))
    const call = lastBatch()
    return call?.[0].html ?? ''
  }

  it('lists a date-field event on a prioritized bill in its window, with the field marker', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', state: 'DC', priority: 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(bill, 'f1', isoDay(2))
    const html = await emailed()
    expect(html).toContain('Comment deadline: HB 12')
    expect(html).toContain('DC HB 12')
    expect(html).toContain('/email-icons/event__3b82f6.png')
    expect(html).toContain('title="Comment deadline"')
    expect(html).toContain(`focusEvent=cf-f1-${bill}`)
  })

  it('leaves out an unprioritized bill\'s date, a date outside the window, and a malformed value', async () => {
    const plain = await seedBill({ billNumber: 'HB 1', priority: null, externalId: 'legiscan:1' })
    const prio = await seedBill({ billNumber: 'HB 2', priority: 'high', externalId: 'legiscan:2' })
    await addField('f1', 'Comment deadline')
    await addField('f2', 'Board vote')
    await addField('f3', 'Notes date')
    await setValue(plain, 'f1', isoDay(2))
    await setValue(prio, 'f1', isoDay(8))
    await setValue(prio, 'f2', isoDay(-1))
    await setValue(prio, 'f3', 'someday')
    await addField('f4', 'Coalition letter due')
    await setValue(prio, 'f4', isoDay(0))
    const html = await emailed()
    expect(html).toContain('Coalition letter due: HB 2')
    expect(html.split('focusEvent=').length - 1).toBe(1)
  })

  it('includes the window\'s last day (day 6) and leaves out the day after (day 7)', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', state: 'DC', priority: 'high' })
    await addField('f6', 'Last day')
    await addField('f7', 'Day after')
    await setValue(bill, 'f6', isoDay(6))
    await setValue(bill, 'f7', isoDay(7))
    const html = await emailed()
    expect(html).toContain('Last day: HB 12')
    expect(html).not.toContain('Day after: HB 12')
  })

  it('puts a date-field event on its day, among the day\'s hearings', async () => {
    const bill = await seedBill({ billNumber: 'HB 12', state: 'DC', priority: 'high' })
    await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(3), description: 'Hearing on HB 12' })
    await addField('f1', 'Comment deadline')
    await setValue(bill, 'f1', isoDay(1))
    const html = await emailed()
    expect(html.indexOf('Comment deadline: HB 12')).toBeGreaterThan(-1)
    expect(html.indexOf('Comment deadline: HB 12')).toBeLessThan(html.indexOf('Hearing on HB 12'))
  })
})

// A companion group has one value per custom field and one priority (#374, #376,
// #381): the date projects once per group, from the member holding the group's
// current value, whenever any member carries a priority (#639).
describe('date custom fields on companion groups', () => {
  const db = () => getDb(env.DB)
  const stamp = (n: number) => `2026-01-0${n} 00:00:00`

  async function group(key: string, members: Record<string, 'high' | 'medium' | 'low' | null>) {
    const ids: Record<string, string> = {}
    for (const [number, priority] of Object.entries(members)) {
      ids[number] = await seedBill({ billNumber: number, state: 'DC', priority, externalId: `legiscan:${number}` })
      await db().update(bills).set({ groupKey: key, ...(priority ? { prioritySetAt: stamp(1) } : {}) }).where(eq(bills.id, ids[number]))
    }
    return ids
  }

  it('projects a date set on a member with no priority while the priority sits on another member', async () => {
    const m = await group('g1', { 'HB 1': null, 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(5), stamp(2))

    const rows = await fieldEvents()
    expect(rows.map(e => e.description)).toEqual(['Comment deadline: HB 1'])
    expect(rows[0].id).toBe('cf-f1-group-g1')
    expect(rows[0].bills.map(b => b.id)).toEqual([m['HB 1']])
  })

  it('projects only the current value when a stale date is left on another member and both carry a priority', async () => {
    const m = await group('g1', { 'HB 1': 'high', 'SB 1': 'low' })
    await addField('f1', 'Comment deadline')
    await setValue(m['SB 1'], 'f1', isoDay(3), stamp(2))
    await setValue(m['HB 1'], 'f1', isoDay(6), stamp(3))

    const rows = await fieldEvents()
    expect(rows.map(e => [e.description, e.date])).toEqual([['Comment deadline: HB 1', isoDay(6)]])
  })

  it('projects at most one event per date field per group, and one per field', async () => {
    const m = await group('g1', { 'HB 1': 'high', 'SB 1': 'high', 'HB 2': 'high' })
    await addField('f1', 'Comment deadline')
    await addField('f2', 'Board vote')
    await setValue(m['HB 1'], 'f1', isoDay(3), stamp(2))
    await setValue(m['SB 1'], 'f1', isoDay(4), stamp(3))
    await setValue(m['HB 2'], 'f1', isoDay(5), stamp(4))
    await setValue(m['HB 1'], 'f2', isoDay(6), stamp(2))
    await setValue(m['SB 1'], 'f2', isoDay(7), stamp(1))

    const rows = await fieldEvents()
    expect(rows.map(e => [e.description, e.date]).sort()).toEqual([
      ['Board vote: HB 1', isoDay(6)],
      ['Comment deadline: HB 2', isoDay(5)],
    ])
  })

  it('leaves out a group with no priority on any member, whichever member holds the date', async () => {
    const m = await group('g1', { 'HB 1': null, 'SB 1': null })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(5))
    expect(await fieldEvents()).toEqual([])
  })

  it('breaks a tie in the value\'s timestamp toward the larger bill id, as the group\'s value does', async () => {
    const m = await group('g1', { 'HB 1': 'high', 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(3), stamp(2))
    await setValue(m['SB 1'], 'f1', isoDay(4), stamp(2))
    const winner = [m['HB 1'], m['SB 1']].sort().at(-1)!
    expect((await fieldEvents()).map(e => e.billId)).toEqual([winner])
  })

  it('replaces an older value with a later one set on another member', async () => {
    const m = await group('g1', { 'HB 1': 'high', 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(3), '2020-01-01 00:00:00')
    await setValue(m['SB 1'], 'f1', isoDay(4), stamp(2))
    expect((await fieldEvents()).map(e => e.date)).toEqual([isoDay(4)])
  })

  it('projects no event when the group\'s current value is not a real date, even if a stale member holds one', async () => {
    const m = await group('g1', { 'HB 1': 'high', 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(3), stamp(2))
    await setValue(m['SB 1'], 'f1', 'soon', stamp(3))
    expect(await fieldEvents()).toEqual([])
  })

  it('falls back to the older member\'s date once the current value is cleared', async () => {
    const m = await group('g1', { 'HB 1': 'high', 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(3), stamp(2))
    await setValue(m['SB 1'], 'f1', isoDay(4), stamp(3))
    await db().delete(billCustomFieldValues).where(and(eq(billCustomFieldValues.billId, m['SB 1']), eq(billCustomFieldValues.fieldId, 'f1')))
    expect((await fieldEvents()).map(e => [e.billId, e.date])).toEqual([[m['HB 1'], isoDay(3)]])
  })

  it('keeps groups separate: two groups each project their own value, and an ungrouped bill projects as before', async () => {
    const a = await group('ga', { 'HB 1': 'high', 'SB 1': null })
    const b = await group('gb', { 'HB 2': null, 'SB 2': 'low' })
    const solo = await seedBill({ billNumber: 'HB 9', state: 'DC', priority: 'medium', externalId: 'legiscan:9' })
    await addField('f1', 'Comment deadline')
    await setValue(a['SB 1'], 'f1', isoDay(3), stamp(2))
    await setValue(b['HB 2'], 'f1', isoDay(4), stamp(2))
    await setValue(solo, 'f1', isoDay(5), stamp(2))
    expect((await fieldEvents()).map(e => e.description).sort()).toEqual(['Comment deadline: HB 2', 'Comment deadline: HB 9', 'Comment deadline: SB 1'])
  })

  it('shows the group\'s priority on the event\'s bill, not the holder\'s own', async () => {
    const m = await group('g1', { 'HB 1': null, 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(5), stamp(2))
    expect((await fieldEvents())[0].bills[0].priority).toBe('high')
  })

  it('projects the same one event in the feed, the dashboard count, and the week-ahead email', async () => {
    const m = await group('g1', { 'HB 1': null, 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(2), stamp(2))
    await setValue(m['SB 1'], 'f1', isoDay(1), stamp(1))

    expect(await upcomingCount()).toBe(1)
    const ics = await feed()
    expect(ics).toContain('UID:cf-f1-group-g1')
    expect(ics).not.toContain(`UID:cf-f1-${m['SB 1']}`)
    expect(ics).not.toContain(`UID:cf-f1-${m['HB 1']}`)
  })

  it('keeps the same id and feed UID when a later value on another member replaces the holder, and links the new holder', async () => {
    const m = await group('g1', { 'HB 1': 'high', 'SB 1': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(m['HB 1'], 'f1', isoDay(3), stamp(2))
    const [before] = await fieldEvents()
    expect([before.id, before.uid, before.billId]).toEqual(['cf-f1-group-g1', 'cf-f1-group-g1', m['HB 1']])

    await setValue(m['SB 1'], 'f1', isoDay(4), stamp(3))
    const [after] = await fieldEvents()
    expect([after.id, after.uid, after.billId, after.date]).toEqual(['cf-f1-group-g1', 'cf-f1-group-g1', m['SB 1'], isoDay(4)])
    expect(vevent(await feed(), 'cf-f1-group-g1')).toBeDefined()
  })

  it('keys a grouped event by its group key, not its bill id', async () => {
    const a = await group('same', { 'HB 1': 'high' })
    await group('other', { 'HB 2': 'high' })
    await addField('f1', 'Comment deadline')
    await setValue(a['HB 1'], 'f1', isoDay(3), stamp(2))
    const rows = await fieldEvents()
    expect(rows.map(e => e.id)).toEqual(['cf-f1-group-same'])
  })
})
