import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0053 widened the feed_events type CHECK by rebuilding the table, and — unlike the
// identical rebuilds in 0016 and 0043 — never re-created the two indexes DROP TABLE
// took with it. Nothing declares them outside api/migrations (the Drizzle schema in
// api/src/db/schema.ts defines columns only), so the loss was silent: the default
// feed's ORDER BY datetime(created_at) DESC went back to scanning and sorting the
// whole table on every load, with no failing test and no error.
//
// This asserts the END STATE of the whole chain rather than 0062's SQL, so the next
// rebuild that forgets them fails here instead of quietly degrading the feed again.
describe('feed_events indexes survive the migration chain', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('keeps idx_feed_events_bill_id and idx_feed_events_created', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'feed_events'",
    ).all<{ name: string }>()
    const names = results.map((r) => r.name)
    expect(names).toContain('idx_feed_events_bill_id')
    expect(names).toContain('idx_feed_events_created')
  })
})
