/**
 * Prioritized-bills / Upcoming-hearings widget headers used to be a single
 * `<div role="link" tabIndex={0}>` wrapping the whole bar, with the "N
 * unvoted" <Link> (and, for prioritized bills, the count chip) nested inside
 * it — an interactive element containing another interactive element, which
 * is invalid ARIA and confuses assistive tech (see maybeOpenInNewTab's own
 * doc comment, which already names this exact shape as the reason it exists).
 *
 * The fix makes the header title itself the only interactive control in the
 * row (role="link"), with the chips/unvoted-link as siblings beside it —
 * never nested. These tests guard the un-nesting, and that keyboard/click
 * navigation still work for both the header and the sibling unvoted link.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/auth/me') {
      return {
        id: 'u1', email: 'a@b.c', name: 'A', role: 'member', subtitle: null,
        canVote: true, emailDigestEnabled: false, emailWeekAheadEnabled: false,
        lastSeenFeed: null, isLastOwner: false,
      }
    }
    if (path === '/config') {
      return { states: ['NJ'], modules: { 'waiting-for-vote': true, 'upcoming-hearings': true } }
    }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') {
      return { billCount: 10, memberCount: 3, calendarUpcomingCount: 0, calendarUpcomingDays: 30 }
    }
    if (path === '/stats/sidebar') {
      return {
        priorityBillCount: 3,
        unvotedPriorityCount: 2,
        upcomingHearings: [
          {
            hearingKey: 'h1', eventHash: 'e1', type: 'Hearing', date: '2026-08-01', time: '10:00',
            location: null, description: 'Budget hearing', bills: [],
          },
          {
            hearingKey: 'h2', eventHash: 'e2', type: 'Hearing', date: '2026-08-02', time: '10:00',
            location: null, description: 'Second hearing', bills: [],
          },
        ],
        priorityBills: [],
      }
    }
    if (path.startsWith('/feed')) return { latestEventAt: null, lastSeenFeed: null }
    return {}
  }),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

/** Spy helper: captures the router location on every render. */
function LocationCapture({ onLocation }: { onLocation: (loc: Location) => void }) {
  const loc = useLocation()
  onLocation(loc)
  return null
}

function renderSidebar(onLocation: (loc: Location) => void = () => {}) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <ConfigProvider>
          <SidebarRefreshProvider>
            <NotificationsProvider>
              <FeedUnreadProvider>
                <Sidebar isOpen={false} onClose={() => {}} />
                <LocationCapture onLocation={onLocation} />
              </FeedUnreadProvider>
            </NotificationsProvider>
          </SidebarRefreshProvider>
        </ConfigProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('Sidebar widget headers do not nest interactive elements', () => {
  // Anchored exact match — "prioritized bills" alone also substring-matches
  // the unvoted chip's own accessible name ("2 prioritized bills waiting on
  // your vote"), so an unanchored regex would find both. The header's own
  // accessible name has no "waiting on your vote" suffix, so anchoring with
  // ^…$ pins the query to the header link specifically.
  const HEADER_NAME = /^3 prioritized bills$/i

  it('the prioritized-bills header link contains no nested interactive descendant', async () => {
    renderSidebar()
    const header = await screen.findByRole('link', { name: HEADER_NAME })
    expect(header.querySelector('a,button,[role="link"],[role="button"]')).toBeNull()
  })

  it('the upcoming-hearings header link contains no nested interactive descendant', async () => {
    renderSidebar()
    const header = await screen.findByRole('link', { name: /upcoming hearings/i })
    expect(header.querySelector('a,button,[role="link"],[role="button"]')).toBeNull()
  })

  it('the hearings count badge has no stacking override — no HoverTooltip of its own to protect, so it stays under the stretched overlay and clicking it still reaches the header link', async () => {
    renderSidebar()
    const header = await screen.findByRole('link', { name: /upcoming hearings/i })
    const row = header.parentElement as HTMLElement
    const badge = within(row).getByText('2')
    // Unlike the prioritized-bills chip (which DOES get lifted, to keep its
    // own HoverTooltip working), this badge has no hover affordance to lose —
    // giving it position:relative/zIndex would only create a needless dead
    // zone where a click used to reach the header's /calendar navigation.
    expect(badge.style.position).not.toBe('relative')
    expect(badge.style.zIndex).toBe('')
  })

  it('the unvoted link is its own separate control, not a descendant of the header', async () => {
    renderSidebar()
    const header = await screen.findByRole('link', { name: HEADER_NAME })
    const unvotedLink = await screen.findByRole('link', { name: /waiting on your vote/i })
    expect(header.contains(unvotedLink)).toBe(false)
  })

  it('Enter on the prioritized-bills header navigates to the priority filter', async () => {
    const locations: Location[] = []
    renderSidebar(loc => { locations.push(loc) })
    const header = await screen.findByRole('link', { name: HEADER_NAME })
    fireEvent.keyDown(header, { key: 'Enter' })

    await waitFor(() => {
      const last = locations[locations.length - 1]
      expect(last?.pathname).toBe('/bills')
    })
    const last = locations[locations.length - 1]
    expect(last?.search).toContain('priority=high')
  })

  it('Enter on the upcoming-hearings header navigates to the calendar', async () => {
    const locations: Location[] = []
    renderSidebar(loc => { locations.push(loc) })
    const header = await screen.findByRole('link', { name: /upcoming hearings/i })
    fireEvent.keyDown(header, { key: 'Enter' })

    await waitFor(() => {
      const last = locations[locations.length - 1]
      expect(last?.pathname).toBe('/calendar')
    })
  })

  it('clicking the unvoted link navigates independently of the header', async () => {
    const locations: Location[] = []
    renderSidebar(loc => { locations.push(loc) })
    const unvotedLink = await screen.findByRole('link', { name: /waiting on your vote/i })
    fireEvent.click(unvotedLink, { button: 0 })

    await waitFor(() => {
      const last = locations[locations.length - 1]
      expect(last?.search).toContain('unvoted=1')
    })
  })

  // Regression: the count chip sits above the title link's stretched overlay
  // (so its own HoverTooltip can receive hover — see the priorityMeaning
  // comment in Sidebar.tsx), which used to leave a direct click on it doing
  // nothing. Rather than re-nesting it inside the header's role="link" (invalid
  // ARIA — the whole point of this file), it's its own real <button> that
  // reaches the same destination independently.
  describe('the prioritized-bills count chip is its own interactive control', () => {
    it('is a real button with an accessible name matching the header', async () => {
      renderSidebar()
      const chip = await screen.findByRole('button', { name: HEADER_NAME })
      expect(chip.tagName.toLowerCase()).toBe('button')
    })

    it('is not nested inside the header link (siblings, not descendants)', async () => {
      renderSidebar()
      const header = await screen.findByRole('link', { name: HEADER_NAME })
      const chip = await screen.findByRole('button', { name: HEADER_NAME })
      expect(header.contains(chip)).toBe(false)
    })

    it('clicking it navigates to the same destination as the header', async () => {
      const locations: Location[] = []
      renderSidebar(loc => { locations.push(loc) })
      const chip = await screen.findByRole('button', { name: HEADER_NAME })
      fireEvent.click(chip, { button: 0 })

      await waitFor(() => {
        const last = locations[locations.length - 1]
        expect(last?.pathname).toBe('/bills')
      })
      const last = locations[locations.length - 1]
      expect(last?.search).toContain('priority=high')
    })

    it('is keyboard-activatable (Enter navigates, same as the header)', async () => {
      const user = userEvent.setup()
      const locations: Location[] = []
      renderSidebar(loc => { locations.push(loc) })
      const chip = await screen.findByRole('button', { name: HEADER_NAME })
      chip.focus()
      await user.keyboard('{Enter}')

      await waitFor(() => {
        const last = locations[locations.length - 1]
        expect(last?.pathname).toBe('/bills')
      })
      const last = locations[locations.length - 1]
      expect(last?.search).toContain('priority=high')
    })

    it('still shows its own hover tooltip (stays above the stretched overlay)', async () => {
      renderSidebar()
      const chip = await screen.findByRole('button', { name: HEADER_NAME })
      fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
      expect(screen.getByText('3 prioritized bills')).toBeInTheDocument()
    })
  })

  it('the upcoming-hearings count chip stays a plain badge — clicking it still reaches the header via the overlay, not its own control', async () => {
    renderSidebar()
    expect(screen.queryByRole('button', { name: /upcoming hearings/i })).toBeNull()
  })
})
