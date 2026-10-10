import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0079: calendar events gain the kind central now sends with each bill
// calendar entry (#295). Existing events keep everything they had, including
// the UID and SEQUENCE calendar clients already know them by. A fork's DC
// deadlines, filed under their own source by PR 217's code, become bill
// entries of kind deadline.
describe('0079_calendar_event_kind', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0079' })
    const insert = env.DB.prepare(`INSERT INTO calendar_events (id, uid, bill_id, source, sequence, date, description, status) VALUES (?, ?, ?, ?, ?, '2026-10-20', ?, ?)`)
    await env.DB.batch([
      insert.bind('hearing', 'hearing-legiscan-9001-1-house-cmte-on-elections@team', 'bill-1', 'hearing', 3, 'House Cmte on Elections', 'confirmed'),
      insert.bind('custom', 'custom-1@team', null, 'custom', 0, 'Coalition call', 'cancelled'),
      insert.bind('deadline', 'hearing-legiscan-1012600400-10-mayor-s-response-due@team', 'bill-2', 'deadline', 1, 'Mayor\'s response due', 'confirmed'),
    ])
    await applyMigrations()
  })

  it('adds a kind, files a fork\'s deadlines as bill entries, and leaves every UID and SEQUENCE as it was', async () => {
    const { results } = await env.DB.prepare(`SELECT id, uid, source, sequence, status, kind FROM calendar_events ORDER BY id`).all()
    expect(results).toEqual([
      { id: 'custom', uid: 'custom-1@team', source: 'custom', sequence: 0, status: 'cancelled', kind: null },
      { id: 'deadline', uid: 'hearing-legiscan-1012600400-10-mayor-s-response-due@team', source: 'hearing', sequence: 1, status: 'confirmed', kind: 'deadline' },
      { id: 'hearing', uid: 'hearing-legiscan-9001-1-house-cmte-on-elections@team', source: 'hearing', sequence: 3, status: 'confirmed', kind: null },
    ])
  })
})
