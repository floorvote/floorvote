import { describe, it, expect } from 'vitest'
import {
  STUB_REFRESH_BUDGET_FLOOR, STUB_REFRESH_RETRY_HOURS,
  budgetAllowsStubRefresh, isDetailStale, refreshDue, stubRefreshFloor, stubRefreshMaxUsed, type StubRefreshRow,
} from '../../src/lib/stubRefresh'

// The pure halves of the stub refresh (lib/stubRefresh.ts): when a bill's
// detail is stale, when a view may queue a refresh of it, and the budget floor
// a refresh must leave untouched.

const NOW = new Date('2026-10-16T12:00:00Z')
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ')

const row = (over: Partial<StubRefreshRow> = {}): StubRefreshRow => ({
  billId: 1, provider: 'legiscan', changeHash: 'h2', detailHash: 'h1',
  detailRequestedHash: null, detailRequestedAt: null, ...over,
})

describe('isDetailStale', () => {
  it('is stale when the detail was fetched at an older change than the bill is at', () => {
    expect(isDetailStale({ changeHash: 'h2', detailHash: 'h1' })).toBe(true)
  })

  it('is current when the detail was fetched at the change the bill is at, and stale again once it moves', () => {
    expect(isDetailStale({ changeHash: 'h2', detailHash: 'h2' })).toBe(false)
    expect(isDetailStale({ changeHash: 'h3', detailHash: 'h2' })).toBe(true)
  })

  it('is stale when the detail was never fetched', () => {
    expect(isDetailStale({ changeHash: 'h1', detailHash: null })).toBe(true)
    // A raw pass stores a new bill with an empty change hash.
    expect(isDetailStale({ changeHash: '', detailHash: null })).toBe(true)
  })
})

describe('refreshDue', () => {
  it('is due for a stale bill no view has queued a refresh of', () => {
    expect(refreshDue(row(), NOW)).toBe(true)
  })

  it('is not due for a current bill, which is due once it goes stale', () => {
    expect(refreshDue(row({ detailHash: 'h2' }), NOW)).toBe(false)
    expect(refreshDue(row({ detailHash: 'h1' }), NOW)).toBe(true)
  })

  it('is not due again for the change a refresh was already queued for, only for an earlier one', () => {
    expect(refreshDue(row({ detailRequestedHash: 'h2', detailRequestedAt: hoursBefore(1) }), NOW)).toBe(false)
    expect(refreshDue(row({ detailRequestedHash: 'h1', detailRequestedAt: hoursBefore(1) }), NOW)).toBe(true)
  })

  it('is due again once the bill changes past the change a refresh was queued for', () => {
    expect(refreshDue(row({ changeHash: 'h3', detailRequestedHash: 'h2', detailRequestedAt: hoursBefore(1) }), NOW)).toBe(true)
  })

  it('retries a refresh that never landed once the retry window has passed, and not before', () => {
    const justInside = row({ detailRequestedHash: 'h2', detailRequestedAt: hoursBefore(STUB_REFRESH_RETRY_HOURS - 0.01) })
    const justPast = row({ detailRequestedHash: 'h2', detailRequestedAt: hoursBefore(STUB_REFRESH_RETRY_HOURS + 0.01) })
    expect(refreshDue(justInside, NOW)).toBe(false)
    expect(refreshDue(justPast, NOW)).toBe(true)
  })

  it('retries no sooner than every few hours, so a failing bill is not hammered', () => {
    expect(STUB_REFRESH_RETRY_HOURS).toBeGreaterThanOrEqual(6)
  })

  it("is never due for a bill another provider writes, only for LegiScan's", () => {
    expect(refreshDue(row({ provider: 'lims' }), NOW)).toBe(false)
    expect(refreshDue(row({ provider: 'mga' }), NOW)).toBe(false)
    expect(refreshDue(row({ provider: 'legiscan' }), NOW)).toBe(true)
  })
})

describe('budget floor', () => {
  it('is a quarter of the monthly limit', () => {
    expect(STUB_REFRESH_BUDGET_FLOOR).toBe(0.25)
    expect(stubRefreshFloor(10_000)).toBe(2_500)
  })

  it('rounds the floor up, so a refresh never takes the last part of a call', () => {
    expect(stubRefreshFloor(10_001)).toBe(2_501)
  })

  it('allows a refresh that leaves the floor intact, on the floor itself and above it', () => {
    // 10,000 - 7,499 = 2,501 left; the refresh spends one and leaves 2,500.
    expect(budgetAllowsStubRefresh(7_499, 10_000)).toBe(true)
    expect(budgetAllowsStubRefresh(0, 10_000)).toBe(true)
  })

  it('blocks a refresh once the calls left are at or under the floor, one call past where it allows one', () => {
    expect(budgetAllowsStubRefresh(7_499, 10_000)).toBe(true)
    expect(budgetAllowsStubRefresh(7_500, 10_000)).toBe(false)
    expect(budgetAllowsStubRefresh(9_999, 10_000)).toBe(false)
    expect(budgetAllowsStubRefresh(12_000, 10_000)).toBe(false)
  })

  it('allows calls up to the limit less the floor, less the one call a refresh spends', () => {
    expect(stubRefreshMaxUsed(10_000)).toBe(7_499)
    expect(stubRefreshMaxUsed(8)).toBe(5)
    expect(stubRefreshMaxUsed(0)).toBe(-1)
  })

  it('blocks every refresh when the limit is unset or not a positive number', () => {
    expect(budgetAllowsStubRefresh(0, 4)).toBe(true)
    expect(budgetAllowsStubRefresh(0, 1)).toBe(false)
    expect(budgetAllowsStubRefresh(0, 0)).toBe(false)
    expect(budgetAllowsStubRefresh(0, -5)).toBe(false)
    expect(budgetAllowsStubRefresh(0, Number.NaN)).toBe(false)
  })
})
