/**
 * Sidebar — draft marker in the prioritized-bills list
 *
 * The widget rendered a prioritized draft bill with the solid navy badge,
 * because /stats/sidebar's PriorityBill shape carried no draft flag. It now
 * selects bills.isDraft and emits `isDraft`, and this list passes it to
 * BillBadge and pairs it with a mini DraftChip.
 *
 * This is the one of the five tight surfaces with room for the visible chip:
 * the badge sits on a block line of its own and the priority chip beside it is
 * absolutely positioned out of flow. See DraftChip's `mini` comment for the
 * width arithmetic at the 230px sidebar minimum.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'
import type { PriorityBill } from './sidebar/types'

let priorityBills: PriorityBill[] = []

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/auth/me') {
      return {
        id: 'u1', email: 'a@b.c', name: 'A', role: 'member', subtitle: null,
        canVote: false, emailDigestEnabled: false, emailWeekAheadEnabled: false,
        lastSeenFeed: null, isLastOwner: false,
      }
    }
    if (path === '/config') return { states: ['NJ'], modules: { 'waiting-for-vote': true, 'upcoming-hearings': false } }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') return { billCount: 10, memberCount: 3, calendarUpcomingCount: 0, calendarUpcomingDays: 30 }
    if (path === '/stats/sidebar') {
      return {
        priorityBillCount: priorityBills.length,
        unvotedPriorityCount: 0,
        upcomingHearings: [],
        upcomingHearingsDays: 30,
        priorityBills,
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

function makeBill(overrides: Partial<PriorityBill> = {}): PriorityBill {
  return {
    id: 'b1', billNumber: 'H 100', sessionSlug: null, state: 'NJ',
    title: 'Elections Act', summary: null, priority: 'high', myVote: null,
    isDraft: false, ...overrides,
  }
}

async function renderSidebar(bills: PriorityBill[]) {
  priorityBills = bills
  const result = render(
    <MemoryRouter initialEntries={['/bills']}>
      <AuthProvider><ConfigProvider><SidebarRefreshProvider><NotificationsProvider><FeedUnreadProvider>
        <Sidebar isOpen={false} onClose={() => {}} />
      </FeedUnreadProvider></NotificationsProvider></SidebarRefreshProvider></ConfigProvider></AuthProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText('H 100')).toBeInTheDocument())
  return result
}

describe('Sidebar prioritized-bills draft marker', () => {
  beforeEach(() => { priorityBills = [] })

  it('renders the dashed badge and a visible Draft chip for a draft bill', async () => {
    await renderSidebar([makeBill({ isDraft: true })])
    const badge = screen.getByText('H 100')
    expect(/dashed/.test(badge.style.border)).toBe(true)
    expect(badge.style.background === 'transparent' || badge.style.background === '').toBe(true)
    expect(screen.getByText('Draft')).toBeTruthy()
  })

  it('renders the solid badge and no Draft text for a filed bill', async () => {
    await renderSidebar([makeBill({ isDraft: false })])
    const badge = screen.getByText('H 100')
    expect(/dashed/.test(badge.style.border)).toBe(false)
    expect(screen.queryByText('Draft')).toBeNull()
  })

  // The chip shares its line with a mini badge, so it must be the mini chip
  // (12px / 2px 6px) — the full-size one is what the width budget was measured
  // against and rejected.
  it('uses the mini chip scale so it sits beside a mini badge', async () => {
    await renderSidebar([makeBill({ isDraft: true })])
    const chip = screen.getByText('Draft')
    expect(chip.style.padding).toBe('2px 6px')
    expect(/dashed/.test(chip.style.border)).toBe(true)
  })
})
