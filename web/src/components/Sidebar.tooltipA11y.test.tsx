import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'

// These nav/widget count chips carry their full meaning only in a HoverTooltip
// (a mouse/focus-revealed bubble marked aria-hidden) — the interactive
// link/chip itself must carry the same meaning as its own accessible name, so
// screen-reader and touch users (who never trigger hover) aren't left with a
// bare number. See HoverTooltip.tsx's default-mode contract.
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/auth/me') {
      return {
        id: 'u1', email: 'a@b.c', name: 'A', role: 'admin', subtitle: null,
        canVote: true, emailDigestEnabled: false, emailWeekAheadEnabled: false,
        lastSeenFeed: null, isLastOwner: false,
      }
    }
    if (path === '/config') {
      return { states: ['NJ'], modules: { 'waiting-for-vote': true, 'upcoming-hearings': true } }
    }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') {
      return { billCount: 127, memberCount: 3, calendarUpcomingCount: 0, calendarUpcomingDays: 30, newMatchesCount: 5 }
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

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <ConfigProvider>
          <SidebarRefreshProvider>
            <NotificationsProvider>
              <FeedUnreadProvider>
                <Sidebar isOpen={false} onClose={() => {}} />
              </FeedUnreadProvider>
            </NotificationsProvider>
          </SidebarRefreshProvider>
        </ConfigProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('Sidebar tooltip chips carry meaning as accessible names', () => {
  it('the "N bills" chip link is named with its meaning', async () => {
    renderSidebar()
    // Anchored exact match — the enclosing Bills NavLink <a> also matches role
    // "link" and (since it has no aria-label of its own) computes its name from
    // content, which includes this chip's aria-label as a substring. The
    // anchors keep the assertion pinned to the chip itself, not that outer link.
    expect(await screen.findByRole('link', { name: /^127 bills available$/i })).toBeTruthy()
  })

  it('the "N new" chip link is named with its meaning', async () => {
    renderSidebar()
    expect(await screen.findByRole('link', { name: /^5 new bills awaiting a priority decision$/i })).toBeTruthy()
  })

  it('the prioritized-bills widget header is named with its count', async () => {
    renderSidebar()
    expect(await screen.findByRole('link', { name: /3 prioritized bills/i })).toBeTruthy()
  })

  it('the unvoted chip link is named with its meaning', async () => {
    renderSidebar()
    expect(await screen.findByRole('link', { name: /2 prioritized bills waiting on your vote/i })).toBeTruthy()
  })

  it('the hearings widget header is named with its count and detail', async () => {
    renderSidebar()
    expect(await screen.findByRole('link', { name: /2 upcoming hearings for prioritized bills in the next 30 days/i })).toBeTruthy()
  })
})

// Regression: these two chips live inside the sidebar's scrollable widget
// region (overflowY: auto), which clips a non-portaled position:fixed bubble
// once an ancestor establishes a containing block for it (e.g. the mobile
// drawer's transform on .sidebar) — reported as the unvoted chip's tooltip
// getting clipped by the sidebar's right edge. Portaling to document.body
// escapes that ancestor subtree entirely. The nav Bills/New/Calendar chips
// above live in the pinned (non-scrolling) nav section, outside that overflow
// container, so they aren't affected and are left as-is.
describe('sidebar tooltips inside the scrollable widget region are portaled to escape clipping', () => {
  it('the unvoted-chip tooltip bubble renders under document.body, not inside the sidebar', async () => {
    const { container } = renderSidebar()
    const unvotedLink = await screen.findByRole('link', { name: /waiting on your vote/i })
    fireEvent.pointerEnter(unvotedLink, { pointerType: 'mouse' })
    const bubble = screen.getByText(/2 prioritized bills waiting on your vote/i)
    expect(bubble).toBeInTheDocument()
    expect(container.contains(bubble)).toBe(false)
    expect(document.body.contains(bubble)).toBe(true)
  })

  it('the prioritized-bills count-chip tooltip bubble is also portaled (same overflow container)', async () => {
    const { container } = renderSidebar()
    const chip = await screen.findByRole('button', { name: /3 prioritized bills/i })
    fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
    const bubble = screen.getByText('3 prioritized bills')
    expect(bubble).toBeInTheDocument()
    expect(container.contains(bubble)).toBe(false)
    expect(document.body.contains(bubble)).toBe(true)
  })
})
