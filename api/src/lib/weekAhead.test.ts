/**
 * Integration tests for runWeekAhead would require a D1-backed test harness.
 * No such harness exists for lib functions in this codebase — the existing
 * lib tests (calendarIcsBody.test.ts, calendarImport.test.ts) are all pure
 * unit tests. The route tests in api/src/routes/ use
 * @cloudflare/vitest-pool-workers with a real D1 binding, but that pattern
 * hasn't been extended to lib functions yet.
 *
 * TODO: once a lib-level D1 test harness is established, cover:
 *   1. Module gate — when 'week-ahead' module is disabled, runWeekAhead
 *      returns without inserting a last_week_ahead_at stamp.
 *   2. Weekday gate — when today's UTCDay doesn't match the configured
 *      weeklyDay, runWeekAhead returns without stamping.
 *   3. Empty week skip — when no calendar_events fall in next 7 days,
 *      runWeekAhead returns without stamping.
 *   4. Hearing filter — a hearing linked only to a bill with null priority
 *      is excluded; a custom event with no bills is always included.
 *   5. User opt-out — a user with email_week_ahead_enabled = 0 is not
 *      included in the recipient list even if they have an active session.
 *   6. Stamp written — when events exist and recipients exist, a
 *      last_week_ahead_at row is upserted into association_config.
 */

import { describe, it } from 'vitest'

describe('runWeekAhead', () => {
  // D1-backed integration tests pending — see module-level comment above.
  it.todo('module gate: disabled module returns without stamping')
  it.todo('weekday gate: wrong day returns without stamping')
  it.todo('empty week: no events in window returns without stamping')
  it.todo('hearing filter: hearing without priority bill excluded; custom event always included')
  it.todo('user opt-out: email_week_ahead_enabled = 0 excludes recipient')
  it.todo('stamp written: last_week_ahead_at upserted when events and recipients exist')
})
