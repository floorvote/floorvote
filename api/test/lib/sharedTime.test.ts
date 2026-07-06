import { describe, it, expect } from 'vitest'
import { dbTsToEpoch } from '../../../shared/time'

// Locks the convention that session-expiry parsing relies on:
// the SQLite space format is UTC, and must NOT be read as local time the way
// `new Date("YYYY-MM-DD HH:MM:SS")` does.
describe('dbTsToEpoch (session expiry parsing)', () => {
  it('treats the space format as UTC (not local)', () => {
    expect(dbTsToEpoch('2026-07-01 12:00:00')).toBe(Date.parse('2026-07-01T12:00:00Z'))
  })

  it('parses the ISO/Z format identically', () => {
    expect(dbTsToEpoch('2026-07-01T12:00:00Z')).toBe(Date.parse('2026-07-01T12:00:00Z'))
  })

  it('space and ISO forms of the same instant agree', () => {
    expect(dbTsToEpoch('2026-07-01 12:00:00')).toBe(dbTsToEpoch('2026-07-01T12:00:00Z'))
  })

  it('returns NaN for an unparseable timestamp (so expiry checks fail closed)', () => {
    expect(Number.isNaN(dbTsToEpoch('not-a-date'))).toBe(true)
  })
})
