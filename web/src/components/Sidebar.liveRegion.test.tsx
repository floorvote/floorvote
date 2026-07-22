import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'

// Whether the mocked vote endpoint should reject, to exercise the rollback path.
const hoisted = vi.hoisted(() => ({ voteShouldFail: false }))

const priorityBill = {
  id: 'bill-1',
  billNumber: 'SB123',
  sessionSlug: 'session-1',
  state: 'NJ',
  title: 'A test bill',
  summary: null,
  priority: 'high' as const,
  myVote: null,
}

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
      return { states: ['NJ'], modules: { 'waiting-for-vote': true } }
    }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') {
      return { billCount: 10, memberCount: 3, calendarUpcomingCount: 0, calendarUpcomingDays: 30 }
    }
    if (path === '/stats/sidebar') {
      return {
        priorityBillCount: 1,
        unvotedPriorityCount: 1,
        upcomingHearings: [],
        priorityBills: [priorityBill],
      }
    }
    if (path.startsWith('/feed')) return { latestEventAt: null, lastSeenFeed: null }
    if (/\/bills\/.*\/votes$/.test(path)) {
      if (hoisted.voteShouldFail) throw new Error('vote failed')
      return {}
    }
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

describe('Sidebar vote live region', () => {
  beforeEach(() => { hoisted.voteShouldFail = false })

  it('renders a polite live region, empty until a vote resolves', async () => {
    renderSidebar()
    const region = document.querySelector('[aria-live="polite"]')
    expect(region).not.toBeNull()
    expect(region?.textContent).toBe('')
  })

  it('announces a successful vote with the bill number and position', async () => {
    renderSidebar()
    // The button's accessible name is now the vote hint (see VoteButton's
    // aria-label), not the short visible label — the visible text is still
    // "Support" (asserted in VoteButton.test.tsx).
    const supportBtn = await screen.findByRole('button', { name: /vote support on this bill/i })
    fireEvent.click(supportBtn)

    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Voted support on SB123')
    })
  })

  it('announces rollback when the vote request fails', async () => {
    hoisted.voteShouldFail = true
    renderSidebar()
    const supportBtn = await screen.findByRole('button', { name: /vote support on this bill/i })
    fireEvent.click(supportBtn)

    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Couldn't save your vote on SB123")
    })
  })
})
