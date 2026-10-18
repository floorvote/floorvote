import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, calendarEvents, calendarEventBills } from '../../src/db/schema'
import { runWeekAhead } from '../../src/lib/weekAhead'

// The week-ahead email lists at most 30 body events, so a busy legislature's
// week stays under Gmail's ~102 KB clip, which would hide the footer and the
// mute link (#675). A body event with a prioritized bill on its agenda is never
// cut and doesn't count toward the 30. The email ends with a line counting the
// rest, linking to the Calendar page.

const sendBatch = vi.hoisted(() => vi.fn(async () => ({ sent: 1, failed: 0 })))
vi.mock('../../src/lib/email', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/lib/email')>(), sendBatch }))

const GMAIL_CLIP_BYTES = 102 * 1024
const CAP = 30
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  await seedSession(await seedUser({ email: 'member@b.com' }))
  const weekday = String(new Date().getUTCDay())
  await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
  sendBatch.mockClear()
})

const label = (i: number) => `Body event ${String(i).padStart(3, '0')} end`

// Body events in chronological order: event i is on day 1 + (i % 5), at a time that grows with i.
async function seedBodyEvents(from: number, to: number, opts: { heavy?: boolean; priorityOf?: (i: number) => string | null } = {}) {
  const db = getDb(env.DB)
  for (let i = from; i < to; i++) {
    const id = `body-${i}`
    const day = 1 + Math.floor(i / 20)  // 20 events a day, days 1 to 5
    await db.insert(calendarEvents).values({
      id, uid: `${id}@test`, billId: null, source: 'body', sequence: 0,
      date: isoDay(day), time: `${String(6 + Math.floor((i % 20) / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00`,
      description: label(i), status: 'confirmed', ruleMatch: null,
      location: opts.heavy ? `Hearing Room ${i}, Legislative Office Building, 100 Capitol Way` : null,
      details: opts.heavy ? `Agenda for the committee on matter ${i}. `.repeat(8) : null,
      url: opts.heavy ? `https://legislature.example.gov/committees/events/${i}/agenda` : null,
    })
    const priority = opts.priorityOf?.(i) ?? null
    const nBills = opts.heavy ? 3 : priority ? 1 : 0
    for (let b = 0; b < nBills; b++) {
      const billId = await seedBill({ billNumber: `HB ${i}${b}`, state: 'DC', priority: b === 0 ? priority : null, externalId: `legiscan:${i}-${b}`, matchType: priority && b === 0 ? undefined : 'keyword' })
      await db.insert(calendarEventBills).values({ eventId: id, billId })
    }
  }
}

async function emailed(): Promise<string> {
  await runWeekAhead(env as any, getDb(env.DB))
  const call = sendBatch.mock.calls.at(-1) as unknown as [unknown, { html: string }[]] | undefined
  return call?.[1][0].html ?? ''
}

const listed = (html: string, from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k).filter(i => html.includes(label(i)))
const OVERFLOW = /and (\d+) more on the calendar/

describe('the week-ahead email, capped at 30 body events (#675)', () => {
  it('lists exactly 30 body events with no overflow line', async () => {
    await seedBodyEvents(0, CAP)
    const html = await emailed()
    expect(listed(html, 0, CAP)).toHaveLength(CAP)
    expect(html).not.toMatch(OVERFLOW)
  })

  it('cuts the 31st: lists 30, then says one more is on the calendar, linking to it', async () => {
    await seedBodyEvents(0, CAP + 1)
    const html = await emailed()
    expect(listed(html, 0, CAP + 1)).toEqual(Array.from({ length: CAP }, (_, i) => i))
    expect(html).not.toContain(label(CAP))
    expect(html).toContain('and 1 more on the calendar')
    expect(html).toMatch(/<a href="[^"]*\/calendar"[^>]*>[^<]*and 1 more on the calendar/)
  })

  it('counts every event left out in the overflow line', async () => {
    await seedBodyEvents(0, 100)
    const html = await emailed()
    expect(listed(html, 0, 100)).toHaveLength(CAP)
    expect(html.match(OVERFLOW)?.[1]).toBe('70')
  })

  it('puts the overflow line after the last day and before the footer', async () => {
    await seedBodyEvents(0, CAP + 5)
    const html = await emailed()
    expect(html.indexOf('more on the calendar')).toBeGreaterThan(html.indexOf(label(CAP - 1)))
    expect(html.indexOf('more on the calendar')).toBeLessThan(html.indexOf('Manage email settings'))
  })

  it('never cuts events with a prioritized bill, however many, and does not count them', async () => {
    await seedBodyEvents(0, 45, { priorityOf: () => 'high' })
    const html = await emailed()
    expect(listed(html, 0, 45)).toHaveLength(45)
    expect(html).not.toMatch(OVERFLOW)
  })

  it('counts 30 unprioritized events on top of any number of prioritized ones', async () => {
    // Prioritized: 0 to 39 (any priority level). Unprioritized: 40 to 79.
    await seedBodyEvents(0, 40, { priorityOf: i => (['high', 'medium', 'low'] as const)[i % 3] })
    await seedBodyEvents(40, 80)
    const html = await emailed()
    expect(listed(html, 0, 40)).toHaveLength(40)
    expect(listed(html, 40, 80)).toHaveLength(CAP)
    expect(html.match(OVERFLOW)?.[1]).toBe('10')
  })

  it('cuts only unprioritized events in a mix, the latest first, keeping the prioritized one among them', async () => {
    // Event 50 is prioritized, among 60 events; the 30 earliest unprioritized stay, plus 50.
    await seedBodyEvents(0, 50)
    await seedBodyEvents(50, 51, { priorityOf: () => 'low' })
    await seedBodyEvents(51, 61)
    const html = await emailed()
    expect(html).toContain(label(50))
    expect(listed(html, 0, 50)).toEqual(Array.from({ length: CAP }, (_, i) => i))
    expect(listed(html, 51, 61)).toEqual([])
    expect(html.match(OVERFLOW)?.[1]).toBe('30')
  })

  it('does not count a cancelled event, or one the calendar hides, toward the overflow', async () => {
    await seedBodyEvents(0, CAP)
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({ id: 'x1', uid: 'x1@test', billId: null, source: 'body', sequence: 0, date: isoDay(5), description: 'Cancelled one', status: 'cancelled', ruleMatch: null })
    await db.insert(calendarEvents).values({ id: 'x2', uid: 'x2@test', billId: null, source: 'body', sequence: 0, date: isoDay(5), description: 'Hidden one', status: 'confirmed', ruleMatch: 0 })
    const html = await emailed()
    expect(html).not.toMatch(OVERFLOW)
    expect(html).not.toContain('Cancelled one')
    expect(html).not.toContain('Hidden one')
  })

  it('does not cut a custom event, which the cap leaves alone', async () => {
    await seedBodyEvents(0, 40)
    await getDb(env.DB).insert(calendarEvents).values({ id: 'c1', uid: 'c1@test', billId: null, source: 'custom', sequence: 0, date: isoDay(5), time: '23:00:00', description: 'Team call', status: 'confirmed' })
    const html = await emailed()
    expect(html).toContain('Team call')
    expect(html.match(OVERFLOW)?.[1]).toBe('10')
  })

  it('counts only the events listed and left out in the summary line, which still adds up', async () => {
    await seedBodyEvents(0, CAP + 12)
    const html = await emailed()
    expect(html).toContain(`${CAP + 12} events in the week ahead`)
  })

  it('keeps a heavy week of 100 realistic body events under Gmail\'s clip, footer and mute link intact', async () => {
    await seedBodyEvents(0, 100, { heavy: true })
    const html = await emailed()
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(GMAIL_CLIP_BYTES)
    expect(html).toContain('Manage email settings')
    expect(html).toContain('Subscribe to your calendar')
    expect(html.match(OVERFLOW)?.[1]).toBe('70')
  })

  it('shows a week under the cap whole, as before, with the footer', async () => {
    await seedBodyEvents(0, 12, { heavy: true })
    const html = await emailed()
    expect(listed(html, 0, 12)).toHaveLength(12)
    expect(html).not.toMatch(OVERFLOW)
    expect(html).toContain('Manage email settings')
  })
})
