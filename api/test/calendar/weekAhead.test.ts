import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, calendarEvents, calendarEventBills } from '../../src/db/schema'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { resetMail, lastBatch } from '../mail'

// The week-ahead email takes a bill's own calendar entries (hearings, markups)
// when the bill is prioritized, by the rule the calendar page applies (#341).

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  await seedSession(await seedUser({ email: 'member@b.com' }))
  const weekday = String(new Date().getUTCDay())
  await getDb(env.DB).insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
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
