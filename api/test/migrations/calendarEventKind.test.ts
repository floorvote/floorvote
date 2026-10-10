import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0079: calendar events gain the kind central now sends with each bill
// calendar entry (#295). Existing events keep everything they had, including
// the UID and SEQUENCE calendar clients already know them by.
describe('0079_calendar_event_kind', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0079' })
    const insert = env.DB.prepare(`INSERT INTO calendar_events (id, uid, bill_id, source, sequence, date, description, status) VALUES (?, ?, ?, ?, ?, '2026-10-20', ?, ?)`)
    await env.DB.batch([
      insert.bind('hearing', 'hearing-legiscan-9001-1-house-cmte-on-elections@team', 'bill-1', 'hearing', 3, 'House Cmte on Elections', 'confirmed'),
      insert.bind('custom', 'custom-1@team', null, 'custom', 0, 'Coalition call', 'cancelled'),
    ])
    await applyMigrations()
  })

  it('adds an empty kind and leaves every event as it was', async () => {
    const { results } = await env.DB.prepare(`SELECT id, uid, sequence, status, kind FROM calendar_events ORDER BY id`).all()
    expect(results).toEqual([
      { id: 'custom', uid: 'custom-1@team', sequence: 0, status: 'cancelled', kind: null },
      { id: 'hearing', uid: 'hearing-legiscan-9001-1-house-cmte-on-elections@team', sequence: 3, status: 'confirmed', kind: null },
    ])
  })
})
