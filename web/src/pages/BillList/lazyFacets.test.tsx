// The Subject and Committee counts load on demand. They are the costly part of GET /bills/facets and are used only
// inside those two filter controls, so the page-load request leaves them out (`omit=subject,committee`) and the page
// asks for them (`only=subject,committee`, under the same filter) when someone is about to use one of those controls:
// a hover, a focus, or opening it, or opening the phone filter sheet. Once asked for, they follow the filter for the
// rest of the page's life. Harness adapted from filterHovers.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { facetsFilterOf, facetsReply, isLazyFacetsCall, isPageFacetsCall } from '../../test/facetsContract'

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

const CONFIG = {
  associationName: 'Test Assoc',
  states: ['RI'],
  positionVocabulary: ['Support', 'Oppose'],
  orgNoun: 'association',
}

const BILL = {
  id: 'b1', billNumber: 'HB 1', title: 'Default bill', state: 'RI', status: '2',
  session: '2025-2026', sessionId: null, yearStart: 2025, yearEnd: 2026,
  abstract: null, url: null, stateUrl: null, lastAction: 'Referred',
  lastActionDate: '2026-02-01', tenantSummary: null, tags: [], priority: null,
  matchType: 'keyword', position: null, relevanceScore: 80, aiProcessedAt: null,
  voteCounts: { support: 0, oppose: 0, neutral: 0 }, myVote: null,
  commentCount: 0, hasNote: false, hasComment: false, updatedAt: '2026-02-01 10:00:00',
  customFieldValues: {},
}

function fullFacets(): Record<string, unknown> {
  return {
    status: { '2': 1 }, priority: { high: 1 }, sessionName: {}, year: { '2025': 1 }, state: { RI: 1 }, position: {},
    tag: {}, field: {}, myBillsCount: 0, newMatchesCount: 0, unvotedCount: 0, draftCount: 0, hasDrafts: false,
    subject: { 'RI:Roads': 4, 'RI:Taxes': 2 }, subjectStates: ['RI'], billStates: ['RI'],
    committee: { 101: 3 }, committeeInfo: { 101: { name: 'Judiciary', state: 'RI', chamber: 'S' } }, hasCommittees: true,
  }
}

type Pending = { path: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }
const api = vi.hoisted(() => ({
  calls: [] as string[],
  full: null as Record<string, unknown> | null,
  /** A facets request this says to hold waits in `pending` until the test settles it. */
  hold: null as ((path: string) => boolean) | null,
  /** A facets request this says to fail is answered with an error. */
  fail: null as ((path: string) => boolean) | null,
  pending: [] as Pending[],
}))

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
  }
  async function apiFetch<T>(path: string): Promise<T> {
    api.calls.push(path)
    if (path === '/auth/me') {
      return { id: 'u1', email: 'u1@example.com', name: 'U1', role: 'member',
        title: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null } as T
    }
    if (path === '/config') return CONFIG as T
    if (path === '/users/me/bills') return [] as T
    if (path === '/config/custom-fields') return [] as T
    if (path.startsWith('/bills/facets')) {
      if (api.fail?.(path)) throw new ApiError(503, 'D1 DB is overloaded')
      if (api.hold?.(path)) return new Promise<T>((resolve, reject) => { api.pending.push({ path, resolve: resolve as (v: unknown) => void, reject }) })
      const { facetsReply: reply } = await import('../../test/facetsContract')
      return reply(path, api.full!) as T
    }
    if (path.startsWith('/bills?')) {
      return { bills: [BILL], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } } as T
    }
    return {} as T
  }
  return { apiFetch, ApiError }
})

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 150,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 150, size: 150 })),
    measureElement: () => {},
  }),
}))

import { BillList } from './index'
import { AuthProvider } from '../../context/AuthContext'
import { SidebarRefreshProvider } from '../../context/SidebarRefreshContext'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.search}</div>
}

function Wrapper({ children, initialUrl }: { children: ReactNode; initialUrl: string }) {
  return (
    <MemoryRouter initialEntries={[initialUrl]}>
      <AuthProvider>
        <SidebarRefreshProvider>{children}<LocationProbe /></SidebarRefreshProvider>
      </AuthProvider>
    </MemoryRouter>
  )
}

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  api.calls = []
  api.full = fullFacets()
  api.hold = null
  api.fail = null
  api.pending = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Renders the page and waits until the page-load facets reply for its filter has been applied. */
async function renderBillList(initialUrl = '/bills') {
  render(<BillList />, { wrapper: (props) => <Wrapper {...props} initialUrl={initialUrl} /> })
  await screen.findByText('Default bill')
  await waitFor(() => expect(api.calls.some(isPageFacetsCall)).toBe(true))
  await act(async () => {})
}

const lazyCalls = () => api.calls.filter(isLazyFacetsCall)
const pageCalls = () => api.calls.filter(isPageFacetsCall)
const lazyPending = () => api.pending.filter(p => isLazyFacetsCall(p.path))
const onlyOf = (path: string) => new URLSearchParams(path.split('?')[1]).get('only')
const urlSearch = () => screen.getByTestId('loc').textContent ?? ''

/** A filter bar control's trigger, not the table's sort header of the same name (that one carries ▲▼). */
function filterButton(label: RegExp): HTMLElement {
  const found = screen.queryAllByRole('button', { name: label }).find(b => !b.textContent?.includes('▲'))
  if (!found) throw new Error(`no filter button ${label}`)
  return found
}
const subjectButton = () => filterButton(/^Subject/)
const committeeButton = () => filterButton(/^Committee/)
const hover = (el: HTMLElement) => fireEvent.pointerEnter(el, { pointerType: 'mouse' })

async function settleLazy(index: number, data: Record<string, unknown>) {
  const p = lazyPending()[index]
  await act(async () => { p.resolve(facetsReply(p.path, data)) })
}

/** Picks High Priority from the Priority filter, which changes the filter. */
function pickHighPriority() {
  fireEvent.click(filterButton(/^Priority/))
  fireEvent.click(screen.getByText('High Priority'))
  fireEvent.click(filterButton(/^Priority/))
}

function openSheet() {
  fireEvent.click(document.querySelector('.mobile-filter-btn') as HTMLElement)
}
/** The phone sheet's row for a dimension: the sheet renders after the desktop bar, so its row is the second match. */
function sheetRow(label: RegExp): HTMLElement | null {
  const matches = screen.queryAllByRole('button', { name: label }).filter(b => !b.textContent?.includes('▲'))
  return matches.length > 1 ? matches[matches.length - 1] : null
}

describe('the page-load facets request', () => {
  it('leaves out the Subject and Committee counts', async () => {
    await renderBillList()
    const [first] = pageCalls()
    expect(new URLSearchParams(first.split('?')[1]).get('omit')).toBe('subject,committee')
    expect(lazyCalls()).toEqual([])
  })

  it('leaves them out under a filter too, and keeps the filter', async () => {
    await renderBillList('/bills?priority=high')
    const [first] = pageCalls()
    const qs = new URLSearchParams(first.split('?')[1])
    expect(qs.get('omit')).toBe('subject,committee')
    expect(qs.getAll('priority')).toEqual(['high'])
  })
})

describe('asking for the Subject and Committee counts', () => {
  it('asks once, under the current filter, when the Subject control is hovered', async () => {
    await renderBillList('/bills?priority=high')
    hover(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    expect(onlyOf(lazyCalls()[0])).toBe('subject,committee')
    expect(facetsFilterOf(lazyCalls()[0])).toBe(facetsFilterOf(pageCalls()[0]))
  })

  it('does not ask again for a storm of hovers while the request is in flight', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList()
    for (let i = 0; i < 6; i++) hover(subjectButton())
    for (let i = 0; i < 3; i++) hover(committeeButton())
    fireEvent.focus(subjectButton())
    await act(async () => {})
    expect(lazyCalls()).toHaveLength(1)
  })

  it('does not ask again once the counts for this filter have landed', async () => {
    await renderBillList()
    hover(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    await act(async () => {})
    for (let i = 0; i < 5; i++) hover(subjectButton())
    fireEvent.click(subjectButton())
    fireEvent.click(subjectButton())
    hover(committeeButton())
    await act(async () => {})
    expect(lazyCalls()).toHaveLength(1)
  })

  it('asks when the Subject control takes focus', async () => {
    await renderBillList()
    fireEvent.focus(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
  })

  it('asks when the Committee control is hovered', async () => {
    await renderBillList()
    hover(committeeButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    expect(onlyOf(lazyCalls()[0])).toBe('subject,committee')
  })

  it('asks when the Committee control is opened', async () => {
    await renderBillList()
    fireEvent.click(committeeButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
  })

  it('asks when the phone filter sheet opens', async () => {
    await renderBillList()
    openSheet()
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    expect(onlyOf(lazyCalls()[0])).toBe('subject,committee')
  })

  it('does not ask while nobody goes near those controls', async () => {
    await renderBillList()
    hover(filterButton(/^Priority/))
    pickHighPriority()
    await waitFor(() => expect(pageCalls()).toHaveLength(2))
    await act(async () => {})
    expect(lazyCalls()).toEqual([])
  })
})

describe('which of the two controls the page offers', () => {
  // The page-load reply here names no subject even where a page ignores `omit`, so only subjectStates can offer it.
  it('offers Subject from subjectStates, with no subject counts loaded', async () => {
    api.full = { ...fullFacets(), subject: {} }
    api.hold = isLazyFacetsCall
    await renderBillList()
    expect(subjectButton()).toBeInTheDocument()
    expect(lazyCalls()).toEqual([])
  })

  it('hides Subject when the instance has no subjects and none is picked', async () => {
    api.full = { ...fullFacets(), subject: {}, subjectStates: [] }
    await renderBillList()
    expect(() => subjectButton()).toThrow()
  })

  it('still offers Subject when one is picked, though the instance reports no subjects', async () => {
    api.full = { ...fullFacets(), subject: {}, subjectStates: [] }
    await renderBillList('/bills?subject=RI%3ARoads')
    expect(subjectButton()).toHaveTextContent('Subject (1)')
  })

  it('offers Committee from hasCommittees, with no committee counts loaded', async () => {
    api.full = { ...fullFacets(), committee: {}, committeeInfo: {}, hasCommittees: true }
    api.hold = isLazyFacetsCall
    await renderBillList()
    expect(committeeButton()).toBeInTheDocument()
    expect(lazyCalls()).toEqual([])
  })

  it('hides Committee when the instance has no committees and none is picked', async () => {
    api.full = { ...fullFacets(), committee: {}, committeeInfo: {}, hasCommittees: false }
    await renderBillList()
    expect(() => committeeButton()).toThrow()
  })

  it('still offers Committee when one is picked, though the instance reports none', async () => {
    api.full = { ...fullFacets(), committee: {}, committeeInfo: {}, hasCommittees: false }
    await renderBillList('/bills?committee=101')
    expect(committeeButton()).toHaveTextContent('Committee (1)')
  })

  it('offers the same two rows in the phone sheet, before any counts load', async () => {
    api.full = { ...fullFacets(), subject: {}, committee: {}, committeeInfo: {}, hasCommittees: true }
    api.hold = isLazyFacetsCall
    await renderBillList()
    openSheet()
    expect(sheetRow(/^Subject/)).toBeInTheDocument()
    expect(sheetRow(/^Committee/)).toBeInTheDocument()
  })

  it('leaves both rows out of the phone sheet where the instance has neither', async () => {
    api.full = { ...fullFacets(), subject: {}, subjectStates: [], committee: {}, committeeInfo: {}, hasCommittees: false }
    await renderBillList()
    openSheet()
    await act(async () => {})
    expect(screen.queryAllByRole('button', { name: /^Subject/ })).toEqual([])
    expect(screen.queryAllByRole('button', { name: /^Committee/ })).toEqual([])
  })
})

describe('while the counts load', () => {
  it('shows a Loading row in the Subject menu, then the subjects with their counts', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList()
    fireEvent.click(subjectButton())
    const menu = screen.getByRole('group', { name: 'Subject' })
    expect(within(menu).getByText('Loading…')).toBeInTheDocument()
    expect(within(menu).queryAllByRole('checkbox')).toEqual([])
    await settleLazy(0, fullFacets())
    expect(within(menu).queryByText('Loading…')).toBeNull()
    expect(within(menu).getByText('Roads')).toBeInTheDocument()
    expect(within(menu).getByText('4')).toBeInTheDocument()
  })

  it('shows a Loading row in the Committee menu, then the committees with their counts', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList()
    fireEvent.click(committeeButton())
    const menu = screen.getByRole('group', { name: 'Committee' })
    expect(within(menu).getByText('Loading…')).toBeInTheDocument()
    expect(within(menu).queryAllByRole('checkbox')).toEqual([])
    await settleLazy(0, fullFacets())
    expect(within(menu).queryByText('Loading…')).toBeNull()
    expect(within(menu).getByText('Judiciary (Senate)')).toBeInTheDocument()
    expect(within(menu).getByText('3')).toBeInTheDocument()
  })

  it('shows a Loading row in the phone sheet’s Subject list, then the subjects', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList()
    openSheet()
    fireEvent.click(sheetRow(/^Subject/)!)
    const list = screen.getByRole('group', { name: 'Subject' })
    expect(within(list).getByText('Loading…')).toBeInTheDocument()
    await settleLazy(0, fullFacets())
    expect(within(list).queryByText('Loading…')).toBeNull()
    expect(within(list).getByText('Roads')).toBeInTheDocument()
  })

  it('shows a Loading row in the phone sheet’s Committee list, then the committees', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList()
    openSheet()
    fireEvent.click(sheetRow(/^Committee/)!)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    await settleLazy(0, fullFacets())
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('Judiciary (Senate)')).toBeInTheDocument()
  })

  // The request can fail (the database's budget spent, D1 7429). The control says so, never "No subjects.", which
  // would claim the instance has none; the page keeps its bills; and the next open asks again, on Loading.
  it('says the counts could not load when the request fails, keeps the page, and asks again on the next open', async () => {
    api.fail = isLazyFacetsCall
    await renderBillList()
    fireEvent.click(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    await act(async () => {})
    const menu = screen.getByRole('group', { name: 'Subject' })
    expect(within(menu).getByText('Couldn’t load subjects.')).toBeInTheDocument()
    expect(within(menu).queryByText('No subjects.')).toBeNull()
    expect(screen.getByText('Default bill')).toBeInTheDocument()
    expect(screen.queryByText(/Failed to load bills/)).toBeNull()

    api.fail = null
    api.hold = isLazyFacetsCall
    fireEvent.click(subjectButton()) // close
    fireEvent.click(subjectButton()) // reopen
    await waitFor(() => expect(lazyPending()).toHaveLength(1))
    const reopened = screen.getByRole('group', { name: 'Subject' })
    expect(within(reopened).getByText('Loading…')).toBeInTheDocument()
    expect(within(reopened).queryByText('Couldn’t load subjects.')).toBeNull()
    await settleLazy(0, fullFacets())
    expect(within(screen.getByRole('group', { name: 'Subject' })).getByText('Roads')).toBeInTheDocument()
  })

  it('says so in the Committee menu and in the phone sheet too', async () => {
    api.fail = isLazyFacetsCall
    await renderBillList()
    fireEvent.click(committeeButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    await act(async () => {})
    const menu = screen.getByRole('group', { name: 'Committee' })
    expect(within(menu).getByText('Couldn’t load committees.')).toBeInTheDocument()
    expect(within(menu).queryByText('No committees.')).toBeNull()
    fireEvent.click(committeeButton()) // close

    openSheet() // asks again, and fails again
    await waitFor(() => expect(lazyCalls()).toHaveLength(2))
    await act(async () => {})
    fireEvent.click(sheetRow(/^Subject/)!)
    const list = screen.getByRole('group', { name: 'Subject' })
    expect(within(list).getByText('Couldn’t load subjects.')).toBeInTheDocument()
    expect(within(list).queryByText('No subjects.')).toBeNull()
  })
})

describe('when the filter changes', () => {
  it('asks for the counts again under the new filter once they have been wanted', async () => {
    await renderBillList()
    hover(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    pickHighPriority()
    await waitFor(() => expect(lazyCalls()).toHaveLength(2))
    const second = new URLSearchParams(lazyCalls()[1].split('?')[1])
    expect(second.getAll('priority')).toEqual(['high'])
    expect(second.get('only')).toBe('subject,committee')
  })

  it('does not ask again when only the sort changes, since the counts do not depend on it', async () => {
    await renderBillList()
    hover(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    await act(async () => {})
    const sortHeader = screen.getAllByRole('button').find(b => b.textContent?.includes('▲') && /Status/.test(b.textContent))!
    fireEvent.click(sortHeader)
    await waitFor(() => expect(urlSearch()).toContain('sort='))
    await act(async () => {})
    expect(lazyCalls()).toHaveLength(1)
  })

  it('never lets a slow reply for an earlier filter overwrite the newer counts', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList()
    hover(subjectButton())
    await waitFor(() => expect(lazyPending()).toHaveLength(1))
    pickHighPriority()
    await waitFor(() => expect(lazyPending()).toHaveLength(2))
    await settleLazy(1, { ...fullFacets(), subject: { 'RI:Roads': 7 } })
    await settleLazy(0, { ...fullFacets(), subject: { 'RI:Roads': 99, 'RI:Stale': 1 } })
    fireEvent.click(subjectButton())
    const menu = screen.getByRole('group', { name: 'Subject' })
    expect(within(menu).getByText('7')).toBeInTheDocument()
    expect(within(menu).queryByText('99')).toBeNull()
    expect(within(menu).queryByText('Stale')).toBeNull()
  })

  it('shows Loading, not the old filter’s counts, when the menu opens before the new counts land', async () => {
    await renderBillList()
    hover(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    await act(async () => {})
    api.hold = isLazyFacetsCall
    pickHighPriority()
    await waitFor(() => expect(lazyPending()).toHaveLength(1))
    fireEvent.click(subjectButton())
    const menu = screen.getByRole('group', { name: 'Subject' })
    expect(within(menu).getByText('Loading…')).toBeInTheDocument()
    expect(within(menu).queryByText('Roads')).toBeNull()
    await settleLazy(0, { ...fullFacets(), subject: { 'RI:Roads': 1 } })
    expect(within(menu).getByText('Roads')).toBeInTheDocument()
  })

  it('keeps the list in an open menu while a pick refetches its counts, then updates them', async () => {
    await renderBillList()
    fireEvent.click(subjectButton())
    const menu = screen.getByRole('group', { name: 'Subject' })
    await within(menu).findByText('Roads')
    api.hold = isLazyFacetsCall
    fireEvent.click(within(menu).getByText('Roads'))
    await waitFor(() => expect(urlSearch()).toContain('subject=RI%3ARoads'))
    await waitFor(() => expect(lazyPending()).toHaveLength(1))
    expect(within(menu).queryByText('Loading…')).toBeNull()
    expect(within(menu).getByText('Taxes')).toBeInTheDocument()
    await settleLazy(0, { ...fullFacets(), subject: { 'RI:Roads': 4, 'RI:Taxes': 1 } })
    expect(within(menu).getByText('1')).toBeInTheDocument()
  })

  it('keeps the on-demand counts when the page-load counts land after them', async () => {
    await renderBillList()
    hover(subjectButton())
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    await act(async () => {})
    api.hold = isPageFacetsCall
    api.full = { ...fullFacets(), subject: { 'RI:Roads': 5 } }
    pickHighPriority()
    await waitFor(() => expect(lazyCalls()).toHaveLength(2))
    await act(async () => {})
    expect(api.pending.filter(p => isPageFacetsCall(p.path))).toHaveLength(1)
    const page = api.pending.find(p => isPageFacetsCall(p.path))!
    await act(async () => { page.resolve(facetsReply(page.path, api.full!)) })
    fireEvent.click(subjectButton())
    const menu = screen.getByRole('group', { name: 'Subject' })
    expect(within(menu).getByText('Roads')).toBeInTheDocument()
    expect(within(menu).getByText('5')).toBeInTheDocument()
  })
})

describe('picked subjects and committees before the counts load', () => {
  it('shows a picked subject’s chip without asking for the counts', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList('/bills?subject=RI%3ARoads')
    expect(screen.getAllByText('Roads').length).toBeGreaterThan(0)
    expect(lazyCalls().filter(c => onlyOf(c)?.includes('subject'))).toEqual([])
  })

  it('shows a picked committee’s chip at once, and names it from a committee-only request', async () => {
    api.hold = isLazyFacetsCall
    await renderBillList('/bills?committee=101')
    expect(screen.getAllByText(/^Referred to committee 101$/).length).toBeGreaterThan(0)
    await waitFor(() => expect(lazyPending()).toHaveLength(1))
    expect(onlyOf(lazyPending()[0].path)).toBe('committee')
    expect(new URLSearchParams(lazyPending()[0].path.split('?')[1]).getAll('committee')).toEqual(['101'])
    await settleLazy(0, fullFacets())
    expect(screen.getAllByText('Referred to Judiciary (Senate)').length).toBeGreaterThan(0)
  })

  it('does not ask again to name a picked committee it has already named', async () => {
    await renderBillList('/bills?committee=101')
    await waitFor(() => expect(lazyCalls()).toHaveLength(1))
    pickHighPriority()
    await waitFor(() => expect(pageCalls()).toHaveLength(2))
    await act(async () => {})
    expect(lazyCalls()).toHaveLength(1)
    expect(screen.getAllByText('Referred to Judiciary (Senate)').length).toBeGreaterThan(0)
  })
})
