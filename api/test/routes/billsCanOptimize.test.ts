import { describe, it, expect } from 'vitest'
import { canOptimize } from '../../src/routes/billsApi/query'

describe('canOptimize', () => {
  it('returns true for default sort', () => {
    expect(canOptimize('default', 'desc')).toBe(true)
    expect(canOptimize('default', 'asc')).toBe(true)
  })

  it('returns true for priority desc', () => {
    expect(canOptimize('priority', 'desc')).toBe(true)
  })

  it('returns false for priority asc', () => {
    expect(canOptimize('priority', 'asc')).toBe(false)
  })

  it('returns true for relevance desc', () => {
    expect(canOptimize('relevance', 'desc')).toBe(true)
  })

  it('returns false for relevance asc', () => {
    expect(canOptimize('relevance', 'asc')).toBe(false)
  })

  it('returns false for non-optimizable sorts', () => {
    for (const col of ['status', 'year', 'session', 'bill', 'state', 'position', 'lastAction']) {
      expect(canOptimize(col, 'desc')).toBe(false)
      expect(canOptimize(col, 'asc')).toBe(false)
    }
  })

  it('returns false for unknown sort columns', () => {
    expect(canOptimize('unknown', 'desc')).toBe(false)
  })

  it('handles every known sort column', () => {
    const knownCols = ['default', 'priority', 'relevance', 'position', 'year', 'session', 'lastAction', 'status', 'state', 'bill']
    for (const col of knownCols) {
      expect(() => canOptimize(col, 'desc')).not.toThrow()
      expect(typeof canOptimize(col, 'desc')).toBe('boolean')
    }
  })
})
