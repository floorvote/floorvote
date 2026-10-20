import { describe, it, expect } from 'vitest'
import { findProvider } from '../src/providers'
import { decideMode, getCurrentEtHour, DEFAULT_FULL_HOURS_ET, DEFAULT_RAW_HOURS_ET } from '../src/lib/sync-schedule'

describe('decideMode', () => {
  const enabled = { syncEnabled: true, fullSyncHoursEt: null, rawSyncHoursEt: null }

  it('returns full at default full hours', () => {
    for (const h of DEFAULT_FULL_HOURS_ET) {
      expect(decideMode(enabled, h)).toBe('full')
    }
  })

  it('returns raw at default raw hours', () => {
    for (const h of DEFAULT_RAW_HOURS_ET) {
      expect(decideMode(enabled, h)).toBe('raw')
    }
  })

  it('returns skip at unscheduled hours', () => {
    expect(decideMode(enabled, 0)).toBe('skip')
    expect(decideMode(enabled, 4)).toBe('skip')
    expect(decideMode(enabled, 22)).toBe('skip')
  })

  it('returns skip when disabled regardless of hour', () => {
    const disabled = { ...enabled, syncEnabled: false }
    expect(decideMode(disabled, 5)).toBe('skip')
    expect(decideMode(disabled, 7)).toBe('skip')
  })

  it('returns skip for sine_die sessions regardless of hour', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: null, rawSyncHoursEt: null, sineDie: 1 }
    expect(decideMode(cfg, 5)).toBe('skip')  // 5 is a default full hour
    expect(decideMode(cfg, 7)).toBe('skip')  // 7 is a default raw hour
    expect(decideMode(cfg, 0)).toBe('skip')
  })

  it('honors session overrides for full hours', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: JSON.stringify([6, 18]), rawSyncHoursEt: null }
    expect(decideMode(cfg, 6)).toBe('full')
    expect(decideMode(cfg, 18)).toBe('full')
    expect(decideMode(cfg, 5)).toBe('skip')  // 5 is default-full but overridden away
  })

  it('honors session overrides for raw hours', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: null, rawSyncHoursEt: JSON.stringify([8, 12, 16]) }
    expect(decideMode(cfg, 8)).toBe('raw')
    expect(decideMode(cfg, 12)).toBe('raw')
    expect(decideMode(cfg, 7)).toBe('skip')  // 7 is default-raw but overridden away
  })

  it('full takes precedence over raw at the same hour', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: JSON.stringify([10]), rawSyncHoursEt: JSON.stringify([10]) }
    expect(decideMode(cfg, 10)).toBe('full')
  })

  it('falls back to defaults when override JSON is malformed', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: 'not json', rawSyncHoursEt: null }
    // hour 5 is default full — should still trigger full despite malformed override
    expect(decideMode(cfg, 5)).toBe('full')
  })

  it('falls back to defaults when override is non-array JSON', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: JSON.stringify({ wrong: 'shape' }), rawSyncHoursEt: null }
    expect(decideMode(cfg, 5)).toBe('full')
  })

  it('falls back to defaults when override contains out-of-range hours', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: JSON.stringify([25, 99]), rawSyncHoursEt: null }
    expect(decideMode(cfg, 5)).toBe('full')  // default fires because override is invalid
  })

  it('falls back to defaults when override contains non-integer hours', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: JSON.stringify([5.5]), rawSyncHoursEt: null }
    expect(decideMode(cfg, 5)).toBe('full')
  })

  it('falls back to defaults when override contains negative hours', () => {
    const cfg = { syncEnabled: true, fullSyncHoursEt: JSON.stringify([-1]), rawSyncHoursEt: null }
    expect(decideMode(cfg, 5)).toBe('full')
  })
})

describe('getCurrentEtHour', () => {
  it('returns the correct ET hour in summer (EDT, UTC-4)', () => {
    // 2026-05-21 15:00 UTC = 2026-05-21 11:00 EDT
    expect(getCurrentEtHour(new Date('2026-05-21T15:00:00Z'))).toBe(11)
  })

  it('returns the correct ET hour in winter (EST, UTC-5)', () => {
    // 2026-01-15 15:00 UTC = 2026-01-15 10:00 EST
    expect(getCurrentEtHour(new Date('2026-01-15T15:00:00Z'))).toBe(10)
  })

  it('handles midnight wrap correctly', () => {
    // 2026-05-21 03:00 UTC = 2026-05-20 23:00 EDT
    expect(getCurrentEtHour(new Date('2026-05-21T03:00:00Z'))).toBe(23)
  })

  it('returns 0-23 integer', () => {
    const h = getCurrentEtHour()
    expect(Number.isInteger(h)).toBe(true)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(23)
  })
})

describe('decideMode with a provider\'s default hours', () => {
  const enabled = { syncEnabled: true, fullSyncHoursEt: null, rawSyncHoursEt: null }
  const hours = Array.from({ length: 24 }, (_, h) => h)

  it('runs a full pass at every hour for Maryland, Virginia, and DC with no override', () => {
    for (const id of ['mga', 'lis', 'lims']) {
      for (const h of hours) expect(decideMode(enabled, h, findProvider(id)), `${id} at ${h}`).toBe('full')
    }
  })

  it('keeps LegiScan\'s full and raw split', () => {
    const legiscan = findProvider('legiscan')
    for (const h of [5, 13, 23]) expect(decideMode(enabled, h, legiscan)).toBe('full')
    for (const h of DEFAULT_RAW_HOURS_ET) expect(decideMode(enabled, h, legiscan)).toBe('raw')
    expect(decideMode(enabled, 0, legiscan)).toBe('skip')
  })

  it('uses a session override whatever its provider', () => {
    const cfg = { ...enabled, fullSyncHoursEt: JSON.stringify([6]) }
    expect(decideMode(cfg, 6, findProvider('mga'))).toBe('full')
    expect(decideMode(cfg, 12, findProvider('mga'))).toBe('skip')
  })
})
