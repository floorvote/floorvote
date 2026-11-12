import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiFetch } from './api'
import { FACETS_FRESH_WINDOW_MS, isFacetsPath, isOwnWritePath, needsFreshFacets, noteFreshFacets, noteOwnWrite } from './facetsFreshness'

// The server keeps a member's facets for a minute (api/src/lib/facetsCache.ts). After the member's own edit, from any
// page, every facets request the server may have kept from before it asks once with Cache-Control: no-cache, so their
// change shows: on the list after editing on the bill page, after a reload, and on a filter they come back to. A
// facets request already counted afresh since the edit asks from the cache again, so a click costs no recount.

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response
}

function stubFetch() {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return jsonResponse(200, {})
  }))
  return calls
}
const asksFresh = (init: RequestInit) => (init.headers as Record<string, string>)['Cache-Control'] === 'no-cache'

beforeEach(() => { sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('which requests are writes that change the counts, and which are facets', () => {
  it('counts a write to bills, comments, the member\'s bills, settings, and admin as an own edit', () => {
    for (const p of ['/bills/b1/priority', '/bills/bulk', '/bills', '/comments/c1', '/users/me/bills/b1', '/config/custom-fields', '/admin/settings']) {
      expect(isOwnWritePath(p), p).toBe(true)
    }
    for (const p of ['/feed/seen', '/notifications/read', '/auth/logout', '/views', '/calendar/x', '/billsx']) {
      expect(isOwnWritePath(p), p).toBe(false)
    }
  })

  it('knows a facets request by its path, with or without a query', () => {
    expect(isFacetsPath('/bills/facets')).toBe(true)
    expect(isFacetsPath('/bills/facets?state=NJ&omit=subject,committee')).toBe(true)
    expect(isFacetsPath('/bills/facetsx')).toBe(false)
    expect(isFacetsPath('/bills?state=NJ')).toBe(false)
  })
})

describe('the own-edit marker', () => {
  it('asks afresh once per facets request after an edit, then from the cache', () => {
    expect(needsFreshFacets('/bills/facets?a=1', 1000)).toBe(false)
    noteOwnWrite(1000)
    expect(needsFreshFacets('/bills/facets?a=1', 1500)).toBe(true)
    expect(needsFreshFacets('/bills/facets?b=2', 1500)).toBe(true)
    noteFreshFacets('/bills/facets?a=1', 1500)
    expect(needsFreshFacets('/bills/facets?a=1', 1600)).toBe(false)
    // Another request the server may have kept from before the edit still asks.
    expect(needsFreshFacets('/bills/facets?b=2', 1600)).toBe(true)
  })

  it('asks again after a later edit', () => {
    noteOwnWrite(1000)
    noteFreshFacets('/bills/facets?a=1', 1500)
    noteOwnWrite(2000)
    expect(needsFreshFacets('/bills/facets?a=1', 2100)).toBe(true)
  })

  it('a fresh request that started before an edit does not answer for it', () => {
    noteOwnWrite(1000)
    noteFreshFacets('/bills/facets?a=1', 1900) // started at 1900
    noteOwnWrite(2000) // the member edits while it is in flight
    expect(needsFreshFacets('/bills/facets?a=1', 2100)).toBe(true)
  })

  it('stops asking once the server can no longer hold counts from before the edit', () => {
    noteOwnWrite(1000)
    expect(needsFreshFacets('/bills/facets?a=1', 1000 + FACETS_FRESH_WINDOW_MS - 1)).toBe(true)
    expect(needsFreshFacets('/bills/facets?a=1', 1000 + FACETS_FRESH_WINDOW_MS + 1)).toBe(false)
  })

  it('survives a reload, since it is in sessionStorage', () => {
    noteOwnWrite(1000)
    expect(sessionStorage.length).toBeGreaterThan(0)
    expect(needsFreshFacets('/bills/facets', 1100)).toBe(true)
  })

  it('never breaks a request when storage throws', () => {
    const denied = () => { throw new Error('denied') }
    vi.stubGlobal('sessionStorage', { getItem: denied, setItem: denied, clear: () => {}, length: 0 })
    expect(() => noteOwnWrite(1000)).not.toThrow()
    expect(needsFreshFacets('/bills/facets', 1100)).toBe(false)
    expect(() => noteFreshFacets('/bills/facets', 1100)).not.toThrow()
  })
})

describe('apiFetch and the own-edit marker', () => {
  it('asks for facets from the cache when the member has edited nothing', async () => {
    const calls = stubFetch()
    await apiFetch('/bills/facets?omit=subject,committee')
    expect(asksFresh(calls[0].init)).toBe(false)
  })

  it('asks afresh after a successful bill write, once for each facets request, then from the cache', async () => {
    const calls = stubFetch()
    await apiFetch('/bills/b1/priority', { method: 'PATCH', body: '{}' })
    await apiFetch('/bills/facets?omit=subject,committee')
    await apiFetch('/bills/facets?omit=subject,committee')
    await apiFetch('/bills/facets?state=NJ&omit=subject,committee')
    await apiFetch('/bills/facets?state=NJ&only=subject,committee')
    expect(calls.slice(1).map(c => asksFresh(c.init))).toEqual([true, false, true, true])
  })

  it('does not count a read, a failed write, or a write elsewhere as an edit', async () => {
    const calls = stubFetch()
    await apiFetch('/bills/b1')
    await apiFetch('/feed/seen', { method: 'POST' })
    vi.mocked(fetch).mockImplementationOnce(async (url, init) => { calls.push({ url: url as string, init: init as RequestInit }); return jsonResponse(500, { error: 'boom' }) })
    await apiFetch('/bills/b1/priority', { method: 'PATCH' }).catch(() => {})
    await apiFetch('/bills/facets')
    expect(asksFresh(calls[calls.length - 1].init)).toBe(false)
  })

  it('keeps a caller\'s own headers when it asks afresh', async () => {
    const calls = stubFetch()
    await apiFetch('/comments/c1', { method: 'DELETE' })
    await apiFetch('/bills/facets', { headers: { 'X-Test': '1' } })
    const headers = calls[1].init.headers as Record<string, string>
    expect(headers['X-Test']).toBe('1')
    expect(headers['Cache-Control']).toBe('no-cache')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('asks afresh again for a request that failed, until one lands', async () => {
    const calls = stubFetch()
    await apiFetch('/bills/b1/vote', { method: 'PUT' })
    vi.mocked(fetch).mockImplementationOnce(async (url, init) => { calls.push({ url: url as string, init: init as RequestInit }); return jsonResponse(503, { error: 'busy' }) })
    await apiFetch('/bills/facets').catch(() => {})
    await apiFetch('/bills/facets')
    await apiFetch('/bills/facets')
    expect(calls.slice(1).map(c => asksFresh(c.init))).toEqual([true, true, false])
  })
})
