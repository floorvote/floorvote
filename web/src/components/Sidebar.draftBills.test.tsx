/**
 * Sidebar — draft marker in the prioritized-bills list
 *
 * The widget rendered a prioritized draft bill with the solid navy badge,
 * because /stats/sidebar's PriorityBill shape carried no draft flag. It now
 * selects bills.isDraft and emits `isDraft`, and this list passes it to
 * BillBadge.
 *
 * There is no visible DraftChip on this surface any more: the priority control
 * shares the badge's line, and a second chip on it made an already cramped row
 * worse. The dashed badge is the visual half of the signal and BillBadge's
 * `draftSrLabel` is the text half — the dashed border on its own is decoration
 * to a screen reader, so it can never be the only cue.
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

  it('renders the dashed badge for a draft bill', async () => {
    await renderSidebar([makeBill({ isDraft: true })])
    const badge = screen.getByText('H 100')
    expect(/dashed/.test(badge.style.border)).toBe(true)
    expect(badge.style.background === 'transparent' || badge.style.background === '').toBe(true)
  })

  // The chip was removed on purpose. If it comes back, it comes back next to
  // the priority control on the same line — the thing this change undid.
  it('shows no visible Draft text beside the badge', async () => {
    await renderSidebar([makeBill({ isDraft: true })])
    expect(screen.queryByText('Draft')).toBeNull()
  })

  // Losing the visible chip must not lose the word. SR_ONLY is
  // position:absolute/1x1 with a clip rect, so it is in the accessibility tree
  // but takes no layout space; testing-library's default `getByText` ignores
  // nothing here, so match on the badge's own accessible name instead.
  it('keeps the word "draft" in the badge accessible name via draftSrLabel', async () => {
    await renderSidebar([makeBill({ isDraft: true })])
    const badge = screen.getByText('H 100')
    expect(badge.textContent).toContain(', draft')
    const sr = badge.querySelector('span')
    expect(sr?.style.position).toBe('absolute')
    // The SR span must never set `display` — see DraftChip.tsx's note on why an
    // inline display outranks the stylesheet and shipped a bug once.
    expect(sr?.style.display).toBe('')
  })

  it('renders the solid badge and no draft cue at all for a filed bill', async () => {
    await renderSidebar([makeBill({ isDraft: false })])
    const badge = screen.getByText('H 100')
    expect(/dashed/.test(badge.style.border)).toBe(false)
    expect(screen.queryByText('Draft')).toBeNull()
    expect(badge.textContent).not.toContain('draft')
  })
})
