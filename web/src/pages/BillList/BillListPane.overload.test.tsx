// When D1 is overloaded (error 7429) GET /bills answers 503 with Retry-After: 10. The split-pane list beside a bill
// retries once after that interval, as the Bills page does, saying so meanwhile. These run the real pane over the real
// apiFetch and a stubbed fetch, so the 503's headers reach the pane the way they do in the browser. (The pane has one
// first-page request per mount, so a newer request that overtakes an older one is covered at the helper's own seam,
// overloadRetry.test.ts, and here by the pane being unmounted while its request is out.)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Bill } from './types'

const net = vi.hoisted(() => ({
  /** Requests made, as `/api` paths. */
  calls: [] as string[],
  /** Answers for the list's requests in order; past the end, the last one repeats. */
  script: [] as Array<() => Response | Promise<Response>>,
  cache: null as null | { params: string; page: { bills: unknown[]; total: number; totalPages: number } },
}))

vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: null, multiState: false, loading: false }),
  useMultiState: () => false,
}))
vi.mock('./index', () => ({
  peekBillsListCache: () => net.cache,
  peekCustomFieldDefs: () => [],
}))

import { BillListPane } from './BillListPane'

function bill(id: string, billNumber: string): Bill {
  return {
    id, billNumber, title: `Title of ${billNumber}`, state: 'RI', status: 'Introduced',
    session: '2026', sessionSlug: '2026', sessionId: null, yearStart: 2026, yearEnd: 2026,
    abstract: null, url: null, stateUrl: null, lastAction: null, lastActionDate: null, tenantSummary: null,
    tags: [], priority: null, matchType: null, isDraft: false, position: null, relevanceScore: null,
    aiProcessedAt: null, newMatchAt: null, triagedAt: null,
    voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
    commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-01-01 00:00:00',
    customFieldValues: {},
  }
}

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const overloaded = () => jsonRes(503, { error: 'database_overloaded' }, { 'Retry-After': '10' })
const listOf = (...bills: Bill[]) => jsonRes(200, { bills, pagination: { page: 1, pageSize: 100, total: bills.length, totalPages: 1 } })

async function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input).replace(/^\/api/, '')
  net.calls.push(path)
  if (path.startsWith('/bills?')) {
    const n = net.calls.filter(p => p.startsWith('/bills?')).length - 1
    const step = net.script[Math.min(n, net.script.length - 1)]
    return step()
  }
  return jsonRes(200, {})
}

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const listCalls = () => net.calls.filter(p => p.startsWith('/bills?'))
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const renderPane = () => render(<MemoryRouter initialEntries={['/RI/2026/HB%201']}><BillListPane /></MemoryRouter>)

beforeEach(() => {
  net.calls = []
  net.script = []
  net.cache = null
  sessionStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the split-pane list when the database is overloaded', () => {
  it('says it is retrying, asks once more after the interval and not before, then shows the list', async () => {
    net.script = [overloaded, () => listOf(bill('b1', 'HB 1'))]
    renderPane()
    expect(await screen.findByText('The list could not load. Retrying…')).toBeInTheDocument()
    expect(screen.queryByText('Couldn’t load bills.')).toBeNull()
    expect(screen.queryByText(/internal_error|database_overloaded/)).toBeNull()
    expect(listCalls()).toHaveLength(1)

    await advance(9_000)
    expect(listCalls()).toHaveLength(1)
    expect(screen.getByText('The list could not load. Retrying…')).toBeInTheDocument()

    await advance(1_500)
    expect(await screen.findByText('Title of HB 1')).toBeInTheDocument()
    expect(screen.queryByText('The list could not load. Retrying…')).toBeNull()
    expect(screen.queryByText('Couldn’t load bills.')).toBeNull()
    expect(listCalls()).toHaveLength(2)
    expect(screen.getByText('1 bill')).toBeInTheDocument()
  })

  it('retries only once: a second 503 says "Couldn’t load bills." and stops asking', async () => {
    net.script = [overloaded]
    renderPane()
    expect(await screen.findByText('The list could not load. Retrying…')).toBeInTheDocument()
    await advance(11_000)
    expect(await screen.findByText('Couldn’t load bills.')).toBeInTheDocument()
    expect(screen.queryByText('The list could not load. Retrying…')).toBeNull()
    expect(listCalls()).toHaveLength(2)
    await advance(120_000)
    expect(listCalls()).toHaveLength(2)
    expect(screen.getByText('Couldn’t load bills.')).toBeInTheDocument()
  })

  it('leaves a 500 as the plain failure: no retry message, no retry', async () => {
    net.script = [() => jsonRes(500, { error: 'internal_error' })]
    renderPane()
    expect(await screen.findByText('Couldn’t load bills.')).toBeInTheDocument()
    expect(screen.queryByText('The list could not load. Retrying…')).toBeNull()
    await advance(60_000)
    expect(listCalls()).toHaveLength(1)
  })

  it('does not retry a 503 that names no interval', async () => {
    net.script = [() => jsonRes(503, { error: 'unavailable' })]
    renderPane()
    expect(await screen.findByText('Couldn’t load bills.')).toBeInTheDocument()
    await advance(60_000)
    expect(listCalls()).toHaveLength(1)
  })

  it('does not retry after the pane is gone', async () => {
    net.script = [overloaded]
    const { unmount } = renderPane()
    expect(await screen.findByText('The list could not load. Retrying…')).toBeInTheDocument()
    unmount()
    await advance(60_000)
    expect(listCalls()).toHaveLength(1)
  })

  it('does not arm a retry from a 503 that lands after the pane is gone', async () => {
    let answer: (r: Response) => void = () => {}
    net.script = [() => new Promise<Response>(resolve => { answer = resolve })]
    const { unmount } = renderPane()
    await vi.waitFor(() => expect(listCalls()).toHaveLength(1))
    unmount()
    await act(async () => { answer(overloaded()) })
    await advance(60_000)
    expect(listCalls()).toHaveLength(1)
  })

  it('keeps the cached first page while it retries, then shows the fresh list', async () => {
    const params = new URLSearchParams([['page', '1'], ['pageSize', '100']]).toString()
    net.cache = { params, page: { bills: [bill('c1', 'HB 77')], total: 1, totalPages: 1 } }
    net.script = [overloaded, () => listOf(bill('b1', 'HB 1'))]
    renderPane()
    expect(await screen.findByText('Title of HB 77')).toBeInTheDocument()
    await vi.waitFor(() => expect(listCalls()).toHaveLength(1))
    await advance(1_000)
    expect(screen.getByText('Title of HB 77')).toBeInTheDocument()
    expect(screen.queryByText('Couldn’t load bills.')).toBeNull()
    expect(listCalls()).toHaveLength(1)

    await advance(10_000)
    const pane = screen.getByRole('navigation', { name: 'Bill list' })
    expect(await within(pane).findByText('Title of HB 1')).toBeInTheDocument()
    expect(within(pane).queryByText('Title of HB 77')).toBeNull()
    expect(listCalls()).toHaveLength(2)
  })
})
