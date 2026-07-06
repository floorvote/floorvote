import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { loadUpcomingDemoHearings, loadDemoBillCalendar } from '../../src/lib/demoCalendar'

const dateFromNow = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

describe('demoCalendar read helpers', () => {
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    billId = await seedBill({ externalId: 'legiscan:111', billNumber: 'A111', title: 'Test Act', state: 'NJ', priority: 'high' })
  })

  describe('loadUpcomingDemoHearings', () => {
    it('returns confirmed hearings in the window with parsed integer billId', async () => {
      await seedCalendarEvent(billId, { source: 'hearing', date: dateFromNow(3), description: 'Hearing A', eventHash: 'eh-in' })
      const db = getDb(env.DB)
      const rows = await loadUpcomingDemoHearings(db, 30)
      expect(rows).toHaveLength(1)
      expect(rows[0].billId).toBe(111)
      expect(rows[0].billNumber).toBe('A111')
      expect(rows[0].type).toBe('Hearing')
      expect(rows[0].description).toBe('Hearing A')
    })

    it('excludes hearings outside the window, cancelled hearings, and custom events', async () => {
      const db = getDb(env.DB)
      await seedCalendarEvent(billId, { source: 'hearing', date: dateFromNow(90), description: 'Too far', eventHash: 'eh-far' })
      await seedCalendarEvent(billId, { source: 'hearing', date: dateFromNow(5), description: 'Cancelled', status: 'cancelled', eventHash: 'eh-cancel' })
      await seedCalendarEvent(billId, { source: 'custom', date: dateFromNow(5), description: 'Custom event', eventHash: 'eh-custom' })
      const rows = await loadUpcomingDemoHearings(db, 30)
      expect(rows).toHaveLength(0)
    })
  })

  describe('loadDemoBillCalendar', () => {
    it('returns the bill\'s confirmed hearings (any date), excludes custom events', async () => {
      const db = getDb(env.DB)
      await seedCalendarEvent(billId, { source: 'hearing', date: dateFromNow(3), description: 'Upcoming hearing', eventHash: 'eh-1' })
      await seedCalendarEvent(billId, { source: 'hearing', date: dateFromNow(-10), description: 'Past hearing', eventHash: 'eh-2' })
      await seedCalendarEvent(billId, { source: 'custom', date: dateFromNow(3), description: 'Custom', eventHash: 'eh-3' })
      const entries = await loadDemoBillCalendar(db, billId)
      expect(entries).toHaveLength(2)
      expect(entries.every((e) => e.type === 'Hearing')).toBe(true)
      expect(entries.map((e) => e.description)).toContain('Upcoming hearing')
      expect(entries.map((e) => e.description)).not.toContain('Custom')
    })
  })
})
