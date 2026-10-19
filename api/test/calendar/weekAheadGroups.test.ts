import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, calendarEvents, calendarEventBills } from '../../src/db/schema'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { PRIORITY_COLORS } from '../../../shared/billChipColors'
import { resetMail, lastBatch } from '../mail'

// A companion group has one priority (#381), so the week-ahead email lists a
// hearing on any member when the group is prioritized, and marks each bill with
// the group's priority, by the rule the calendar page applies.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const HIGH = `title="${PRIORITY_COLORS.high.label}"`

async function emailed(): Promise<string> {
  await runWeekAhead(env as never, getDb(env.DB))
  const call = lastBatch()
  return call?.[0].html ?? ''
}

describe('the week-ahead email: companion groups', () => {
  const db = () => getDb(env.DB)

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    await seedSession(await seedUser({ email: 'member@b.com' }))
    const weekday = String(new Date().getUTCDay())
    await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
    resetMail()
    // Ids sort a < b, so the group's key is a's id. Only the house bill holds the priority.
    await seedBill({ id: 'a-house', billNumber: 'HB 101', state: 'DC', priority: 'high', externalId: 'legiscan:1' })
    await seedBill({ id: 'b-senate', billNumber: 'SB 202', state: 'DC', priority: null, externalId: 'legiscan:2' })
    await db().update(bills).set({ groupKey: 'a-house' }).where(inArray(bills.id, ['a-house', 'b-senate']))
  })

  async function body(id: string, uid: string, ruleMatch: number | null = null) {
    await db().insert(calendarEvents).values({ id, uid, billId: null, source: 'body', sequence: 0, date: isoDay(2), description: 'Senate Committee (body)', status: 'confirmed', ruleMatch })
  }

  it('lists a hearing on the member with no priority of its own, under the group\'s priority marker', async () => {
    await seedCalendarEvent('b-senate', { kind: 'hearing', date: isoDay(2), description: 'Senate hearing on SB 202' })
    const html = await emailed()
    expect(html).toContain('Senate hearing on SB 202')
    expect(html).toContain('DC SB 202')
    expect(html).toContain(HIGH)
  })

  it('lists a body event that links only the member with no priority of its own, with the group\'s marker', async () => {
    await body('b1', 'body-1@test')
    await db().insert(calendarEventBills).values({ eventId: 'b1', billId: 'b-senate' })
    const html = await emailed()
    expect(html).toContain('Senate Committee (body)')
    expect(html).toContain(HIGH)
  })

  it('lists a hearing the body event covers once, as the body event, when only a companion is linked', async () => {
    await seedCalendarEvent('b-senate', { kind: 'hearing', date: isoDay(2), description: 'Hearing on SB 202', uid: 'hearing-202@test' })
    await db().update(calendarEvents).set({ coveredBy: 'body-2@test' })
    await body('b2', 'body-2@test')
    await db().insert(calendarEventBills).values({ eventId: 'b2', billId: 'b-senate' })
    const html = await emailed()
    expect(html).toContain('Senate Committee (body)')
    expect(html).not.toContain('Hearing on SB 202')
  })

  it('leaves out a group none of whose members has a priority', async () => {
    await db().update(bills).set({ priority: null }).where(inArray(bills.id, ['a-house']))
    await seedCalendarEvent('b-senate', { kind: 'hearing', date: isoDay(2), description: 'Senate hearing on SB 202' })
    // A body event the instance's rules don't select (rule_match 0): under "All events" (no rules,
    // #420) every body event reaches the email, so only a deselected one shows the group adding nothing.
    await body('b3', 'body-3@test', 0)
    await db().insert(calendarEventBills).values({ eventId: 'b3', billId: 'b-senate' })
    expect(await emailed()).toBe('')
  })

  it('leaves a bill in no group as it was: its own priority marker', async () => {
    await seedBill({ id: 'c-alone', billNumber: 'HB 303', state: 'DC', priority: 'low', externalId: 'legiscan:3' })
    await seedCalendarEvent('c-alone', { kind: 'hearing', date: isoDay(2), description: 'Lone hearing' })
    const html = await emailed()
    expect(html).toContain('Lone hearing')
    expect(html).toContain(`title="${PRIORITY_COLORS.low.label}"`)
    expect(html).not.toContain(HIGH)
  })
})
