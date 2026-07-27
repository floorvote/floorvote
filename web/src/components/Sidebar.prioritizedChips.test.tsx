/**
 * The prioritized-bills widget's two count chips (the leftmost priority count
 * and the "N unvoted" chip) should turn orange (bgAmberPriority) on hover, and
 * stay orange when the current /bills view is exactly the filter that chip
 * points to — mirroring the nav "N bills"/"N new" chips (see
 * billsChipHover/newChipHover and billsChipSelection in Sidebar.tsx /
 * billsQuery.ts). This mirrors prioritizedChipSelection in billsQuery.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'
import { color } from '../styles/tokens'

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
      return { states: ['NJ'], modules: { 'waiting-for-vote': true, 'upcoming-hearings': false } }
    }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') {
      return { billCount: 10, memberCount: 3, calendarUpcomingCount: 0, calendarUpcomingDays: 30 }
    }
    if (path === '/stats/sidebar') {
      return {
        priorityBillCount: 3,
        unvotedPriorityCount: 2,
        upcomingHearings: [],
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

const PRIORITY_FILTER = '/bills?priority=high&priority=medium&priority=low'

function renderSidebar(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
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

describe('prioritized-bills widget chips: orange highlight on hover and active view', () => {
  it('the priority count chip is NOT orange on an unrelated view, not hovered', async () => {
    renderSidebar('/')
    const chip = await screen.findByRole('button', { name: /3 prioritized bills/i })
    expect(chip).toHaveStyle({ background: color.countChipBg })
  })

  it('the priority count chip turns orange on hover', async () => {
    renderSidebar('/')
    const chip = await screen.findByRole('button', { name: /3 prioritized bills/i })
    fireEvent.mouseEnter(chip)
    expect(chip).toHaveStyle({ background: color.bgHoneySelector })
    fireEvent.mouseLeave(chip)
    expect(chip).toHaveStyle({ background: color.countChipBg })
  })

  it('the priority count chip stays orange when the current view is exactly the priority filter', async () => {
    renderSidebar(PRIORITY_FILTER)
    const chip = await screen.findByRole('button', { name: /3 prioritized bills/i })
    expect(chip).toHaveStyle({ background: color.bgHoneySelector })
  })

  it('the priority count chip is NOT orange when priority is joined by another filter', async () => {
    renderSidebar(`${PRIORITY_FILTER}&status=2`)
    const chip = await screen.findByRole('button', { name: /3 prioritized bills/i })
    expect(chip).toHaveStyle({ background: color.countChipBg })
  })

  it('the unvoted chip is NOT orange on an unrelated view, not hovered', async () => {
    renderSidebar('/')
    const chip = await screen.findByRole('link', { name: /waiting on your vote/i })
    expect(chip).toHaveStyle({ background: color.countChipBg })
  })

  it('the unvoted chip turns orange on hover', async () => {
    renderSidebar('/')
    const chip = await screen.findByRole('link', { name: /waiting on your vote/i })
    fireEvent.mouseEnter(chip)
    expect(chip).toHaveStyle({ background: color.bgHoneySelector })
    fireEvent.mouseLeave(chip)
    expect(chip).toHaveStyle({ background: color.countChipBg })
  })

  it('the unvoted chip stays orange when the current view is exactly the priority+unvoted filter', async () => {
    renderSidebar(`${PRIORITY_FILTER}&unvoted=1`)
    const chip = await screen.findByRole('link', { name: /waiting on your vote/i })
    expect(chip).toHaveStyle({ background: color.bgHoneySelector })
  })

  it('the unvoted chip is NOT orange when only the priority filter (without unvoted) is active', async () => {
    renderSidebar(PRIORITY_FILTER)
    const chip = await screen.findByRole('link', { name: /waiting on your vote/i })
    expect(chip).toHaveStyle({ background: color.countChipBg })
  })

  it('the priority count chip is NOT orange when only the priority+unvoted filter is active (mutually exclusive with the unvoted chip)', async () => {
    renderSidebar(`${PRIORITY_FILTER}&unvoted=1`)
    const chip = await screen.findByRole('button', { name: /3 prioritized bills/i })
    expect(chip).toHaveStyle({ background: color.countChipBg })
  })
})
