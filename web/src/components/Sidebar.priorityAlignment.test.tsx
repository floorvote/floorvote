/**
 * Sidebar — prioritized-bill row: badge/priority-chip alignment and hit targets
 *
 * The priority control used to sit outside the bill Link at
 * `position: absolute; top: 6; right: 10` — outside because a click on a
 * <select> nested in a navigating <a> would navigate, and at a fixed pixel
 * offset because that was the only anchor an out-of-flow box had. Top 6 equals
 * the row's own padding-top, so the control was top-aligned with the badge
 * line; the two chips are different heights (a <select> vs a span), so their
 * centre lines never matched. Present since the initial release (e1373a1).
 *
 * The fix makes them flex siblings on one `alignItems: 'center'` line, which is
 * the alignment itself rather than a number that approximates it, and preserves
 * the "not inside the link" property with the codebase's stretched-::after
 * pattern (.sidebar-priority-bill-link in mobile.css) instead of absolute
 * positioning. These tests pin all three properties: the shared centered line,
 * the control staying out of the anchor, and the vote buttons staying out from
 * under the overlay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'
import type { PriorityBill } from './sidebar/types'

let role = 'member'
let canVote = true
let isDraft = true
function priorityBills(): PriorityBill[] {
  return [{
    id: 'b1', billNumber: 'H 100', sessionSlug: null, state: 'NJ',
    title: 'Elections Act', summary: null, priority: 'high', myVote: null, isDraft,
  }]
}

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/auth/me') {
      return {
        id: 'u1', email: 'a@b.c', name: 'A', role, subtitle: null,
        canVote, emailDigestEnabled: false, emailWeekAheadEnabled: false,
        lastSeenFeed: null, isLastOwner: false,
      }
    }
    if (path === '/config') return { states: ['NJ'], modules: { 'waiting-for-vote': true, 'upcoming-hearings': false } }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') return { billCount: 10, memberCount: 3, calendarUpcomingCount: 0, calendarUpcomingDays: 30 }
    if (path === '/stats/sidebar') {
      return { priorityBillCount: 1, unvotedPriorityCount: 0, upcomingHearings: [], upcomingHearingsDays: 30, priorityBills: priorityBills() }
    }
    if (path.startsWith('/feed')) return { latestEventAt: null, lastSeenFeed: null }
    return {}
  }),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

async function renderSidebar() {
  const result = render(
    <MemoryRouter initialEntries={['/bills']}>
      <AuthProvider><ConfigProvider><SidebarRefreshProvider><NotificationsProvider><FeedUnreadProvider>
        <Sidebar isOpen={false} onClose={() => {}} />
        <Routes><Route path="*" element={<LocationProbe />} /></Routes>
      </FeedUnreadProvider></NotificationsProvider></SidebarRefreshProvider></ConfigProvider></AuthProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText('H 100')).toBeInTheDocument())
  return result
}

/** The priority control: the admin <select>, or the member's read-only chip. */
function priorityControl(): HTMLElement {
  return screen.queryByLabelText('Priority') ?? screen.getByText('High priority')
}

describe('Sidebar prioritized bill — badge / priority chip alignment', () => {
  beforeEach(() => { role = 'member'; canVote = true; isDraft = true })

  for (const [label, r] of [['member (read-only chip)', 'member'], ['admin (priority selector)', 'owner']] as const) {
    describe(label, () => {
      beforeEach(() => { role = r })


      // The alignment relationship, stated structurally: same flex line, centered.
      // A fixed `top` offset on an out-of-flow box cannot express this, which is
      // exactly why the two chips drifted apart.
      it('puts the badge and the priority control on one centered flex line', async () => {
        await renderSidebar()
        const badge = screen.getByText('H 100')
        const control = priorityControl()
        const line = badge.parentElement!
        expect(line.contains(control)).toBe(true)
        expect(line.style.display).toBe('flex')
        expect(line.style.alignItems).toBe('center')
        // And the control is no longer positioned at a hand-picked offset.
        const wrapper = control.closest('div')!
        expect(wrapper.style.position).not.toBe('absolute')
        expect(wrapper.style.top).toBe('')
      })

      // The reason the control was out of flow in the first place. Keep it.
      it('keeps the priority control outside the navigating link', async () => {
        await renderSidebar()
        expect(priorityControl().closest('a')).toBeNull()
      })

      it('does not navigate when the priority control is clicked', async () => {
        await renderSidebar()
        expect(screen.getByTestId('loc').textContent).toBe('/bills')
        await userEvent.click(priorityControl())
        expect(screen.getByTestId('loc').textContent).toBe('/bills')
      })

      // The anchor used to wrap the badge as well, so tabbing here announced
      // the bill number and (via draftSrLabel) the draft status. Shrinking it
      // to the title alone lost both; an aria-label puts them back.
      it('announces the bill number and the draft status from the row link', async () => {
        await renderSidebar()
        const link = screen.getByRole('link', { name: /Elections Act/ })
        const name = link.getAttribute('aria-label')!
        expect(name).toContain('H 100')
        expect(name).toContain('Elections Act')
        // Exactly once — aria-label replaces the computed name, so the badge's
        // own draftSrLabel span (a sibling, not a descendant) cannot double up.
        expect(name.match(/draft/gi)).toHaveLength(1)
        expect(link.textContent!.match(/draft/gi)).toBeNull()
      })

      it('says nothing about drafts on a filed bill', async () => {
        isDraft = false
        await renderSidebar()
        const link = screen.getByRole('link', { name: /Elections Act/ })
        expect(link.getAttribute('aria-label')).toContain('H 100')
        expect(link.getAttribute('aria-label')).not.toMatch(/draft/i)
      })

      // The row still navigates from the title — the hit target the stretched
      // ::after overlay reproduces for the rest of the block.
      it('still navigates to the bill from the row', async () => {
        await renderSidebar()
        await userEvent.click(screen.getByText('Elections Act'))
        // No sessionSlug on this fixture, so billUrl falls back to the id route.
        expect(screen.getByTestId('loc').textContent).toBe('/bills/b1')
      })
    })
  }

  // The overlay is `inset: 0` of .sidebar-priority-bill. If that wrapper grew to
  // cover the vote buttons, every vote click would navigate instead.
  it('scopes the stretched-link wrapper so it excludes the vote buttons', async () => {
    await renderSidebar()
    const link = document.querySelector('.sidebar-priority-bill-link')!
    const wrapper = link.closest('.sidebar-priority-bill')!
    expect(wrapper).not.toBeNull()
    for (const label of ['support', 'neutral', 'oppose']) {
      expect(wrapper.contains(screen.getByRole('button', { name: `Vote ${label} on this bill` }))).toBe(false)
    }
  })

  it('votes without navigating', async () => {
    await renderSidebar()
    await userEvent.click(screen.getByRole('button', { name: 'Vote support on this bill' }))
    expect(screen.getByTestId('loc').textContent).toBe('/bills')
  })
})
