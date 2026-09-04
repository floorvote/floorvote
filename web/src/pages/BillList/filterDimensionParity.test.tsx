// Parity test for the desktop toolbar (index.tsx) and the mobile filter sheet
// (components/FilterSheet.tsx): both must expose the same filter dimensions,
// under the same visibility conditions, with the same labels — driven off the
// single shared registry in lib/filterDimensions.ts, not a hand-copied list
// written a third time here.
//
// Every expectation below is computed FROM `FILTER_DIMENSIONS` /
// `filterDimensionLabel` — never spelled out as a literal string — so:
//   - renaming a label in the registry keeps this test green (both surfaces
//     and this test all read the new label from the same place), and
//   - a dimension whose registry-declared visibility doesn't match what one
//     surface actually renders (added to only one surface, or a visibility
//     condition re-derived instead of reused) fails this test.
//
// Two matrices are exercised for the two conditional dimensions:
//   - State:       uniqueStates = []           (hidden) vs non-empty (shown)
//   - New matches: isAdmin = false             (hidden) vs true      (shown)
// (State's real gate — see lib/filterDimensions.ts — is "at least one known
// state", not "more than one"; the "shown" cases below use two states to
// additionally demonstrate the multi-state case renders correctly.)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { FILTER_DIMENSIONS, filterDimensionLabel, type FilterDimensionContext } from '../../lib/filterDimensions'
import { FilterSheet } from '../../components/FilterSheet'
import type { SubjectGroup } from './FilterPanel'

// --- Desktop harness (BillList), adapted from index.test.tsx ---------------
// Role and known states are mutable so each test can drive the two
// conditional dimensions without duplicating the mock setup.
const authState = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin' }))
const facetState = vi.hoisted(() => ({ states: ['RI'] as string[] }))

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
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

vi.mock('../../lib/api', () => {
  async function apiFetch<T>(path: string): Promise<T> {
    if (path === '/auth/me') {
      return { id: 'u1', email: 'u1@example.com', name: 'U1', role: authState.role,
        subtitle: null, canVote: true, emailDigestEnabled: false, lastSeenFeed: null } as T
    }
    if (path === '/config') return CONFIG as T
    if (path === '/users/me/bills') return [] as T
    if (path === '/config/custom-fields') return [] as T
    if (path.startsWith('/bills/facets')) {
      const stateCounts = Object.fromEntries(facetState.states.map(s => [s, 1]))
      return {
        status: { '2': 1 }, priority: {}, session: {}, year: { '2026': 1 }, state: stateCounts, position: {},
        tags: { Education: 1 }, subjects: { 'RI:Roads': 1 }, customFields: {}, myBillsCount: 0, newMatchesCount: 3,
      } as T
    }
    if (path.startsWith('/bills?')) {
      return { bills: [BILL], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } } as T
    }
    return {} as T
  }
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'ApiError' }
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

import { BillList, knownStates } from './index'
import { AuthProvider } from '../../context/AuthContext'
import { SidebarRefreshProvider } from '../../context/SidebarRefreshContext'

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/bills']}>
      <AuthProvider>
        <SidebarRefreshProvider>{children}</SidebarRefreshProvider>
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
  authState.role = 'member'
  facetState.states = ['RI']
  // knownStates is a module-level cache that only grows (see index.tsx) —
  // clear it so one test's facet response can't leak into the next test's
  // "is State visible" decision.
  knownStates.clear()
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function renderDesktop(opts: { isAdmin: boolean; states: string[] }) {
  authState.role = opts.isAdmin ? 'admin' : 'member'
  facetState.states = opts.states
  render(<BillList />, { wrapper: Wrapper })
  await screen.findByText('Default bill')
}

// --- Mobile harness (FilterSheet) — every dimension gets non-empty options
// so only the two conditional dimensions vary across the matrix.
function renderMobile(ctx: FilterDimensionContext & { newMatchesCount?: number }) {
  const subjectGroups: SubjectGroup[] = [{ state: 'RI', options: [{ value: 'RI:Roads', label: 'Roads', count: 1 }] }]
  return render(
    <FilterSheet
      isOpen
      onClose={() => {}}
      statuses={[]} priorities={[]} positions={[]} tags={[]} subjects={[]} sessions={[]} states={[]}
      minRelevance={0} myBills={false}
      isAdmin={ctx.isAdmin}
      newMatches={false}
      newMatchesCount={ctx.newMatchesCount ?? 3}
      uniqueStates={ctx.uniqueStates}
      statusOptions={[{ value: 'active', label: 'Active' }]}
      priorityOptions={[{ value: 'high', label: 'High' }]}
      positionOptions={[{ value: 'support', label: 'Support' }]}
      tagOptions={['Education']}
      subjectGroups={subjectGroups}
      sessionOptions={[{ value: '2026', label: '2026' }]}
      totalSessionCount={1}
      stateOptions={ctx.uniqueStates.map(s => ({ value: s, label: s }))}
      onStatusChange={() => {}} onPriorityChange={() => {}} onPositionChange={() => {}}
      onTagChange={() => {}} onSubjectChange={() => {}} onSessionChange={() => {}} onStateChange={() => {}}
      onMinRelevanceChange={() => {}} onMyBillsChange={() => {}} onNewMatchesChange={() => {}}
      onClearAll={() => {}}
    />,
  )
}

// The always-visible options-kind dimensions, asserted on both surfaces in
// every context. State and New matches are handled separately since their
// presence itself is the thing under test.
const ALWAYS_VISIBLE_OPTION_KEYS = FILTER_DIMENSIONS
  .filter(d => d.key !== 'state' && d.key !== 'newMatches' && d.key !== 'myBills')
  .map(d => d.key)

describe('filter dimension parity — registry-driven visibility and labels', () => {
  it('every always-visible dimension label rendered by BOTH surfaces comes from the registry', async () => {
    await renderDesktop({ isAdmin: false, states: ['RI'] })
    for (const key of ALWAYS_VISIBLE_OPTION_KEYS) {
      expect(screen.getByRole('button', { name: filterDimensionLabel(key) })).toBeInTheDocument()
    }
    // My bills (a toggle) is always visible too, just not via FilterDropdown.
    expect(screen.getByText(filterDimensionLabel('myBills'))).toBeInTheDocument()
    cleanup()

    renderMobile({ uniqueStates: ['RI'], isAdmin: false })
    for (const key of ALWAYS_VISIBLE_OPTION_KEYS) {
      expect(screen.getByRole('button', { name: new RegExp(`^${filterDimensionLabel(key)}$`) })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: filterDimensionLabel('myBills') })).toBeInTheDocument()
  })

  describe.each([
    { label: 'no known states', uniqueStates: [] as string[] },
    { label: 'one known state', uniqueStates: ['RI'] },
    { label: 'multiple known states', uniqueStates: ['RI', 'NJ'] },
  ])('State dimension — $label', ({ uniqueStates }) => {
    const expectedVisible = FILTER_DIMENSIONS.find(d => d.key === 'state')!.isVisible({ uniqueStates, isAdmin: false })

    it(`is ${expectedVisible ? 'shown' : 'hidden'} on desktop`, async () => {
      await renderDesktop({ isAdmin: false, states: uniqueStates })
      const stateButton = screen.queryByRole('button', { name: filterDimensionLabel('state') })
      expect(stateButton !== null).toBe(expectedVisible)
    })

    it(`is ${expectedVisible ? 'shown' : 'hidden'} on mobile`, () => {
      renderMobile({ uniqueStates, isAdmin: false })
      const stateRow = screen.queryByRole('button', { name: new RegExp(`^${filterDimensionLabel('state')}$`) })
      expect(stateRow !== null).toBe(expectedVisible)
    })
  })

  describe.each([
    { label: 'non-admin', isAdmin: false },
    { label: 'admin', isAdmin: true },
  ])('New matches dimension — $label', ({ isAdmin }) => {
    const expectedVisible = FILTER_DIMENSIONS.find(d => d.key === 'newMatches')!.isVisible({ uniqueStates: ['RI'], isAdmin })

    it(`is ${expectedVisible ? 'shown, with a count' : 'hidden'} on desktop`, async () => {
      await renderDesktop({ isAdmin, states: ['RI'] })
      const newMatchesText = screen.queryByText(filterDimensionLabel('newMatches'))
      expect(newMatchesText !== null).toBe(expectedVisible)
      if (expectedVisible) {
        const button = newMatchesText!.closest('button')!
        expect(within(button).getByText('3')).toBeInTheDocument()
      }
    })

    it(`is ${expectedVisible ? 'shown, with a count' : 'hidden'} on mobile`, () => {
      renderMobile({ uniqueStates: ['RI'], isAdmin, newMatchesCount: 3 })
      const newMatchesButton = screen.queryByRole('button', { name: /new matches/i })
      expect(newMatchesButton !== null).toBe(expectedVisible)
      if (expectedVisible) {
        expect(within(newMatchesButton!).getByText('3')).toBeInTheDocument()
      }
    })
  })

  it('an admin on a multi-state tenant sees State and New matches on both surfaces, with identical labels', async () => {
    await renderDesktop({ isAdmin: true, states: ['RI', 'NJ'] })
    expect(screen.getByRole('button', { name: filterDimensionLabel('state') })).toBeInTheDocument()
    expect(screen.getByText(filterDimensionLabel('newMatches'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: filterDimensionLabel('state') }))
    expect(screen.getByText('RI')).toBeInTheDocument()
    expect(screen.getByText('NJ')).toBeInTheDocument()
    cleanup()

    renderMobile({ uniqueStates: ['RI', 'NJ'], isAdmin: true })
    expect(screen.getByRole('button', { name: new RegExp(`^${filterDimensionLabel('state')}$`) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new matches/i })).toBeInTheDocument()
  })
})
