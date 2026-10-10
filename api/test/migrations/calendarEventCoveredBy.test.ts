import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0082: calendar events gain covered_by, the body event central says covers a
// bill's calendar entry (#297). Existing events keep everything they had,
// including the UID and SEQUENCE calendar clients already know them by, and
// nothing is covered until central says so.
describe('0082_calendar_event_covered_by', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0082' })
    const insert = env.DB.prepare(`INSERT INTO calendar_events (id, uid, bill_id, source, kind, sequence, date, description, status) VALUES (?, ?, ?, ?, ?, ?, '2026-10-23', ?, ?)`)
    await env.DB.batch([
      insert.bind('hearing', 'hearing-legiscan-1012600769-hearing-2026-10-23-public-hearing-on-b26-0769@team', 'bill-1', 'hearing', 'hearing', 2, 'Public Hearing on B26-0769', 'confirmed'),
      insert.bind('council', 'council-2405@lims.dccouncil.gov', null, 'council', null, 1, 'Committee of the Whole hearing', 'confirmed'),
    ])
    await applyMigrations()
  })

  it('adds an empty covered_by and leaves every event as it was', async () => {
    const { results } = await env.DB.prepare(`SELECT id, uid, source, sequence, status, covered_by FROM calendar_events ORDER BY id`).all()
    expect(results).toEqual([
      { id: 'council', uid: 'council-2405@lims.dccouncil.gov', source: 'council', sequence: 1, status: 'confirmed', covered_by: null },
      { id: 'hearing', uid: 'hearing-legiscan-1012600769-hearing-2026-10-23-public-hearing-on-b26-0769@team', source: 'hearing', sequence: 2, status: 'confirmed', covered_by: null },
    ])
  })
})
