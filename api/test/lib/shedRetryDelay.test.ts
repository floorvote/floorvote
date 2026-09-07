import { describe, it, expect } from 'vitest'
import { shedRetryDelay } from '../../src/queue/processor'

describe('shedRetryDelay', () => {
  it('doubles the base delay on each successive attempt', () => {
    expect(shedRetryDelay(60, 1)).toBe(60)
    expect(shedRetryDelay(60, 2)).toBe(120)
    expect(shedRetryDelay(60, 3)).toBe(240)
    expect(shedRetryDelay(60, 4)).toBe(480)
  })

  it('caps a single wait at an hour, well inside the platform bound of 86400', () => {
    expect(shedRetryDelay(60, 20)).toBe(3600)
    expect(shedRetryDelay(60, 100)).toBeLessThanOrEqual(86400)
  })

  it('passes an immediate retry through untouched', () => {
    // The priority-to-standard tier fallback retries with no delay; backoff
    // must not turn that into a wait.
    expect(shedRetryDelay(0, 5)).toBe(0)
  })

  it('covers hours rather than minutes across a ten-retry budget', () => {
    const total = Array.from({ length: 10 }, (_, i) => shedRetryDelay(60, i + 1))
      .reduce((a, b) => a + b, 0)
    // A flat 60s delay would give 600s. The point of the change is that a
    // provider shedding for longer than ten minutes no longer dead-letters
    // everything in flight.
    expect(total).toBeGreaterThan(4 * 3600)
  })
})
