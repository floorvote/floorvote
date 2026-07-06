import { describe, it, expect } from 'vitest'
import { dbTsToEpoch } from './time'

describe('dbTsToEpoch', () => {
  it('parses ISO-8601 (e.g. last_seen_feed) as UTC', () => {
    expect(dbTsToEpoch('2026-06-06T14:00:00.000Z')).toBe(Date.UTC(2026, 5, 6, 14, 0, 0))
  })

  it('parses SQLite space format (datetime("now")) as UTC', () => {
    // no T, no Z, but it IS UTC — must not be parsed as local time
    expect(dbTsToEpoch('2026-06-06 14:00:00')).toBe(Date.UTC(2026, 5, 6, 14, 0, 0))
  })

  it('returns the same epoch for the two spellings of one instant', () => {
    expect(dbTsToEpoch('2026-06-06 14:00:00')).toBe(dbTsToEpoch('2026-06-06T14:00:00.000Z'))
  })

  it('orders a same-day space-format 14:00 above an ISO 09:00', () => {
    expect(dbTsToEpoch('2026-06-06 14:00:00')).toBeGreaterThan(dbTsToEpoch('2026-06-06T09:00:00.000Z'))
  })
})
