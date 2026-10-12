import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, calendarEvents, calendarEventBills } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('DELETE /api/bills/:id calendar links', () => {
  let adminTok: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    adminTok = await seedSession(await seedUser({ role: 'admin', email: 'a@x.com' }))
  })

  it('removes the draft calendar links and leaves the event and its other bill links alone', async () => {
    const draft = await seedBill({ isDraft: true, matchType: 'manual', title: 'Draft with hearing' })
    const other = await seedBill({ billNumber: 'HB 1', externalId: 'legiscan:1' })
    const eventId = await seedCalendarEvent(other)
    const db = getDb(env.DB)
    await db.insert(calendarEventBills).values([
      { eventId, billId: draft },
      { eventId, billId: other },
    ])

    const res = await SELF.fetch(`https://x/api/bills/${draft}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(204)

    expect(await db.select().from(bills).where(eq(bills.id, draft)).get()).toBeUndefined()
    expect(await db.select().from(calendarEventBills).where(eq(calendarEventBills.billId, draft)).all()).toEqual([])
    expect(await db.select().from(calendarEventBills).where(eq(calendarEventBills.eventId, eventId)).all())
      .toEqual([{ eventId, billId: other }])
    expect(await db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)).get()).toBeDefined()
  })

  it('keeps an event whose only linked bill was the deleted draft', async () => {
    const draft = await seedBill({ isDraft: true, matchType: 'manual', title: 'Draft, sole link' })
    const eventId = await seedCalendarEvent(draft)
    const db = getDb(env.DB)
    await db.insert(calendarEventBills).values({ eventId, billId: draft })

    const res = await SELF.fetch(`https://x/api/bills/${draft}`, { method: 'DELETE', headers: { Cookie: `session=${adminTok}` } })
    expect(res.status).toBe(204)

    expect(await db.select().from(calendarEventBills).where(eq(calendarEventBills.billId, draft)).all()).toEqual([])
    expect(await db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)).get()).toBeDefined()
  })
})
