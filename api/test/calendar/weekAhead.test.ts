import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { env } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, calendarEvents, calendarEventBills, users } from '../../src/db/schema'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { resetMail, lastBatch } from '../mail'

// The week-ahead email takes a bill's own calendar entries (hearings, markups)
// when the bill is prioritized, by the rule the calendar page applies (#341).

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

beforeEach(async () => {
  await clearDb()
  await seedSession(await seedUser({ email: 'member@b.com' }))
  const weekday = String(new Date().getUTCDay())
  await getDb(env.DB).insert(associationConfig).values({ key: 'week_ahead_day', value: weekday })
  resetMail()
})

async function emailed(): Promise<string> {
  await runWeekAhead(env as any, getDb(env.DB))
  const call = lastBatch()
  return call?.[0].html ?? ''
}

describe('the week-ahead email, for a bill\'s own calendar entries', () => {
  it('lists a hearing on a prioritized bill, with its bill', async () => {
    const bill = await seedBill({ billNumber: 'HB 100', state: 'DC', priority: 'high' })
    await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(2), description: 'Public Hearing on HB 100' })
    const html = await emailed()
    expect(html).toContain('Public Hearing on HB 100')
    expect(html).toContain('DC HB 100')
  })

  it('leaves out a hearing on an unprioritized bill', async () => {
    const bill = await seedBill({ billNumber: 'HB 200', state: 'DC', priority: null, matchType: 'keyword', externalId: 'legiscan:2' })
    await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(2), description: 'Public Hearing on HB 200' })
    expect(await emailed()).toBe('')
  })

  it('leaves out a cancelled hearing', async () => {
    const bill = await seedBill({ billNumber: 'HB 300', state: 'DC', priority: 'high' })
    await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(2), description: 'Public Hearing on HB 300', status: 'cancelled' })
    expect(await emailed()).toBe('')
  })

  it('lists a markup on a prioritized bill', async () => {
    const bill = await seedBill({ billNumber: 'HB 400', state: 'DC', priority: 'low' })
    await seedCalendarEvent(bill, { kind: 'markup', date: isoDay(3), description: 'Committee markup of HB 400' })
    expect(await emailed()).toContain('Committee markup of HB 400')
  })

  it('leaves out a deadline, as the docs promise', async () => {
    const bill = await seedBill({ billNumber: 'HB 500', state: 'DC', priority: 'high' })
    await seedCalendarEvent(bill, { kind: 'deadline', date: isoDay(3), description: 'Mayor response due on HB 500' })
    expect(await emailed()).toBe('')
  })

  it('lists one hearing on two prioritized bills once, with both bills', async () => {
    const a = await seedBill({ billNumber: 'HB 600', state: 'DC', priority: 'high', externalId: 'legiscan:6' })
    const b = await seedBill({ billNumber: 'HB 601', state: 'DC', priority: 'medium', externalId: 'legiscan:7' })
    const hearing = { kind: 'hearing', date: isoDay(2), time: '10:00:00', location: 'Room 1', description: 'Joint hearing on housing' }
    await seedCalendarEvent(a, { ...hearing, uid: 'h-a@test', eventHash: 'ha' })
    await seedCalendarEvent(b, { ...hearing, uid: 'h-b@test', eventHash: 'hb' })
    const html = await emailed()
    expect(html.split('Joint hearing on housing').length - 1).toBe(1)
    expect(html).toContain('DC HB 600')
    expect(html).toContain('DC HB 601')
  })

  it('still lists custom events and a custom event linking a prioritized bill', async () => {
    const bill = await seedBill({ billNumber: 'HB 700', state: 'DC', priority: 'high' })
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({ id: 'c1', uid: 'custom-1@test', billId: null, source: 'custom', sequence: 0, date: isoDay(1), description: 'Team call', status: 'confirmed' })
    await db.insert(calendarEvents).values({ id: 'c2', uid: 'custom-2@test', billId: null, source: 'custom', sequence: 0, date: isoDay(1), description: 'Strategy session', status: 'confirmed' })
    await db.insert(calendarEventBills).values({ eventId: 'c2', billId: bill })
    const html = await emailed()
    expect(html).toContain('Team call')
    expect(html).toContain('Strategy session')
    expect(html).toContain('DC HB 700')
  })

  it('lists a hearing covered by a body event once, as the body event', async () => {
    const bill = await seedBill({ billNumber: 'HB 800', state: 'DC', priority: 'high' })
    await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(2), description: 'Hearing on HB 800', uid: 'hearing-800@test' })
    const db = getDb(env.DB)
    await db.update(calendarEvents).set({ coveredBy: 'body-800@test' })
    await db.insert(calendarEvents).values({ id: 'b1', uid: 'body-800@test', billId: null, source: 'body', sequence: 0, date: isoDay(2), description: 'Committee hearing (body)', status: 'confirmed', ruleMatch: null })
    await db.insert(calendarEventBills).values({ eventId: 'b1', billId: bill })
    const html = await emailed()
    expect(html).toContain('Committee hearing (body)')
    expect(html).not.toContain('Hearing on HB 800')
  })
})

// A run that isn't the email's weekday, or with notification emails off, says it
// skipped, so it can't mark a failed run's alert resolved (lib/jobAlert.ts).
describe('whether a run did its work', () => {
  const save = (key: string, value: string) =>
    getDb(env.DB).insert(associationConfig).values({ key, value }).onConflictDoUpdate({ target: associationConfig.key, set: { value } })

  it('says it skipped on a day that is not its weekday', async () => {
    await save('week_ahead_day', String((new Date().getUTCDay() + 1) % 7))
    expect(await runWeekAhead(env as any, getDb(env.DB))).toEqual({ skipped: 'not-today' })
  })

  it('says it skipped with notification emails off', async () => {
    await save('notification_emails_enabled', 'false')
    expect(await runWeekAhead(env as any, getDb(env.DB))).toEqual({ skipped: 'off' })
  })

  it('says nothing about skipping on its day', async () => {
    expect(await runWeekAhead(env as any, getDb(env.DB))).toBeUndefined()
  })

  it('goes out on Friday when no day was saved, and is not-today on any other day', async () => {
    await getDb(env.DB).delete(associationConfig).where(eq(associationConfig.key, 'week_ahead_day'))
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-20T11:00:00Z'))  // Friday
      expect(await runWeekAhead(env as any, getDb(env.DB))).toBeUndefined()
      vi.setSystemTime(new Date('2026-11-21T11:00:00Z'))  // Saturday
      expect(await runWeekAhead(env as any, getDb(env.DB))).toEqual({ skipped: 'not-today' })
    } finally { vi.useRealTimers() }
  })

  it('sends to people with the week ahead on, and not to one who turned it off', async () => {
    await getDb(env.DB).update(users).set({ emailWeekAheadEnabled: 0 }).where(eq(users.email, 'member@b.com'))
    await seedSession(await seedUser({ email: 'on@b.com' }))
    const bill = await seedBill({ billNumber: 'HB 5', state: 'DC', priority: 'high' })
    await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(2), description: 'Public Hearing on HB 5' })
    await runWeekAhead(env as any, getDb(env.DB))
    expect(lastBatch().flatMap(m => m.to)).toEqual(['on@b.com'])
  })
})
