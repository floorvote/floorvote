import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as api from '../../lib/api'
import { billListLoader, peekBillsListCache } from './index'

function loaderArgs(url: string) {
  return { params: {}, request: new Request(url), context: {} } as never
}

/** One bill, so a warmed cache is distinguishable from an untouched one. */
const onePage = { bills: [{ id: 'b1' }], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } }

type Attempt = [path: string, init?: { signal?: AbortSignal }]

/**
 * The attempts this test's own loader run made, picked out by the `status=`
 * marker it put in the URL rather than by position.
 *
 * Both pieces of state these tests read — the apiFetch spy and the module-level
 * billsListCache — are shared, and a retry loop from a neighbouring test can
 * still land in either after that test has finished. Indexing positionally, or
 * asserting on the cache without checking whose params it holds, would then be
 * reading someone else's run. Path discriminates cleanly here (unlike in
 * Feed.preload.test.tsx, where the component's refetch rebuilds the loader's
 * exact query string), so every assertion below goes through a marker.
 */
const marked = (calls: Attempt[], marker: string): Attempt[] =>
  calls.filter(([path]) => String(path).includes(`status=${marker}`))

const attemptsFor = (spy: { mock: { calls: unknown[] } }, marker: string): Attempt[] =>
  marked(spy.mock.calls as Attempt[], marker)

beforeEach(() => { vi.restoreAllMocks() })

describe('billListLoader', () => {
  it('prefetches the bills list for the current URL params before render', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue(
      { bills: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } } as never,
    )
    await billListLoader(loaderArgs('http://localhost/bills?status=Introduced'))
    const attempts = attemptsFor(spy, 'Introduced')
    expect(attempts).toHaveLength(1)
    expect(attempts[0][0].startsWith('/bills?')).toBe(true)
    // Routed through apiFetchForLoader → retryFetch, so the request carries a
    // signal (the 10s deadline, combined with the loader's cancellation).
    // A bare apiFetch would be called with no init.
    expect(attempts[0][1]?.signal).toBeTruthy()
  })

  // The three race tests below run on real timers. Fake ones would also have to
  // stand in for AbortSignal.timeout, which vitest does not patch; a few hundred
  // real milliseconds is cheaper than the mock that would replace it.

  // The fast path is what makes BillList paint from cache with no loading frame
  // at all, so it is the half of the race worth protecting. 150ms of real delay
  // rather than a microtask: an instantly-resolving mock settles ahead of even a
  // 0ms timer, so it would pass no matter how short the unblock window was.
  it('warms the list cache when the prefetch beats the unblock deadline', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async () => {
      await new Promise<void>((r) => { setTimeout(r, 150) })
      return onePage as never
    })
    await expect(billListLoader(loaderArgs('http://localhost/bills?status=Fast'))).resolves.toBeNull()
    const cache = peekBillsListCache()
    expect(cache?.params).toContain('status=Fast')
    expect(cache?.page.bills).toHaveLength(1)
  })

  // Before the race the loader simply awaited the prefetch, and since retryFetch
  // has no attempt cap a stalled backend meant it never resolved and never
  // rejected — the router had nothing to commit, so a deep link sat on the root
  // splash and an in-app navigation sat on the previous page, both forever.
  it('resolves anyway when the prefetch misses the unblock deadline', async () => {
    let release: () => void = () => {}
    vi.spyOn(api, 'apiFetch').mockImplementation(async () => {
      await new Promise<void>((r) => { release = r })
      return onePage as never
    })
    const started = Date.now()
    await expect(billListLoader(loaderArgs('http://localhost/bills?status=Slow'))).resolves.toBeNull()
    // It waited out the unblock instead of returning immediately. Without this a
    // loader that never blocked at all would also "resolve anyway" and the test
    // would be pinning nothing.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    // Losing the cache warm is the expected cost; the component fetches for
    // itself and shows its own loading state while it does.
    expect(peekBillsListCache()?.params ?? '').not.toContain('status=Slow')
    release()
  })

  // The regression guard. React Router does not fire request.signal for a run it
  // considers committed, and the timer winning is exactly that: the loader
  // returns, the navigation commits, and nothing else holds the prefetch. An
  // un-aborted retryFetch loop left there retries forever — holding
  // visibilitychange and online listeners — for the life of the tab.
  it('aborts the in-flight prefetch when the unblock deadline wins', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      // Mirror the real apiFetch and honour the signal it was handed, so an
      // abort actually unwinds the retry loop instead of leaving it parked.
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    }))
    await billListLoader(loaderArgs('http://localhost/bills?status=Aborted'))
    const attempts = attemptsFor(spy, 'Aborted')
    expect(attempts).toHaveLength(1)
    expect(attempts[0][1]?.signal?.aborted).toBe(true)
  })

  it('does not throw if the prefetch fails — the component surfaces its own error state', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new Error('network'))
    await expect(billListLoader(loaderArgs('http://localhost/bills?status=Broken'))).resolves.toBeNull()
    expect(peekBillsListCache()?.params ?? '').not.toContain('status=Broken')
  })
})
