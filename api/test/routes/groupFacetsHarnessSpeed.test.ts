import { describe, it, expect, beforeAll } from 'vitest'
import { reset, facets, total } from './groupFacetsHarness'

// The harness's requests must cost the same however many a file has already made (#860). Through `SELF.fetch` each
// request cost more than the one before it (an empty database, a 20-call batch at 0.2s early in a file and over a
// second after 300 calls), so the last test of a random-fixture file took twenty times longer than its first and
// timed out on a busy machine, with no change to any count. The check compares the fastest of the last three
// batches with the fastest of the first three in the same run, so a slow or busy machine slows both and the ratio
// holds. The fastest, not the median, because a burst of load from another process lands on single batches and the
// fastest batch of a window is the one it missed. It is one test, with the list and the facets alternating, because
// the slowdown is the file's total and a second test would start slow.
const BATCH = 50
const BATCHES = 8

describe('the group facet harness', () => {
  beforeAll(async () => { await reset() })

  it('answers its last requests as fast as its first', async () => {
    const ms: number[] = []
    for (let b = 0; b < BATCHES; b++) {
      const t0 = performance.now()
      for (let i = 0; i < BATCH; i++) {
        await total()
        await facets()
      }
      ms.push(performance.now() - t0)
    }
    const early = Math.min(...ms.slice(0, 3))
    const late = Math.min(...ms.slice(-3))
    expect(late, `batches of ${BATCH} list and ${BATCH} facet requests took ${ms.map(Math.round).join(', ')}ms`).toBeLessThan(early * 3)
  }, 120_000)
})
