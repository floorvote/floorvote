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
// `role` lets the priority-change test render as an admin (CompactPrioritySelect
// only renders for admins; members see a read-only PriorityChip instead).
const hoisted = vi.hoisted(() => ({ voteShouldFail: false, role: 'member' as 'member' | 'admin' }))

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
        id: 'u1', email: 'a@b.c', name: 'A', role: hoisted.role, subtitle: null,
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
    if (/\/bills\/.*\/priority$/.test(path)) {
      return { priority: 'low' }
    }
    return {}
  }),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

// Renders the Sidebar inside a `#root` div appended to document.body — mirroring
// the real app shell (see main.tsx) — so tests can assert the live region's
// position relative to `#root`, and simulate `#root` being inerted/aria-hidden
// the way useFocusTrap does while an overlay (e.g. a Picker/PopPanel) is open.
function renderSidebar() {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  const rendered = render(
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
    { container: root },
  )
  return { root, ...rendered }
}

describe('Sidebar vote live region', () => {
  beforeEach(() => { hoisted.voteShouldFail = false; hoisted.role = 'member' })

  it('renders a polite live region, empty until a vote resolves', async () => {
    const { root } = renderSidebar()
    const region = document.querySelector('[aria-live="polite"]')
    expect(region).not.toBeNull()
    expect(region?.textContent).toBe('')
    root.remove()
  })

  it('portals the live region to document.body, outside the #root subtree', async () => {
    const { root } = renderSidebar()
    const region = document.querySelector('[aria-live="polite"]')
    expect(region).not.toBeNull()
    // Not a descendant of #root (which is what useFocusTrap inerts/aria-hides
    // while a Picker/PopPanel overlay is open) — it must be a sibling instead,
    // the same way PopPanel already portals its panel to document.body.
    expect(root.contains(region)).toBe(false)
    expect(region?.parentElement).toBe(document.body)
    expect(region?.getAttribute('aria-live')).toBe('polite')
    root.remove()
  })

  it('keeps announcing a vote even while #root is inert/aria-hidden (overlay open)', async () => {
    const { root } = renderSidebar()
    const supportBtn = await screen.findByRole('button', { name: /vote support on this bill/i })

    // Simulate an open overlay (Picker/PopPanel), which is what useFocusTrap
    // does to #root for the duration it's open.
    root.setAttribute('inert', '')
    root.setAttribute('aria-hidden', 'true')

    fireEvent.click(supportBtn)

    await waitFor(() => {
      const region = document.querySelector('[aria-live="polite"]')
      expect(region?.textContent).toBe('Voted support on SB123')
      // The region itself must not be inside the inerted/aria-hidden subtree —
      // otherwise assistive tech would swallow the announcement.
      expect(region?.closest('[aria-hidden="true"]')).toBeNull()
      expect(region?.closest('[inert]')).toBeNull()
    })

    root.removeAttribute('inert')
    root.removeAttribute('aria-hidden')
    root.remove()
  })

  it('announces a successful vote with the bill number and position', async () => {
    const { root } = renderSidebar()
    // The button's accessible name is now the vote hint (see VoteButton's
    // aria-label), not the short visible label — the visible text is still
    // "Support" (asserted in VoteButton.test.tsx).
    const supportBtn = await screen.findByRole('button', { name: /vote support on this bill/i })
    fireEvent.click(supportBtn)

    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Voted support on SB123')
    })
    root.remove()
  })

  it('announces rollback when the vote request fails', async () => {
    hoisted.voteShouldFail = true
    const { root } = renderSidebar()
    const supportBtn = await screen.findByRole('button', { name: /vote support on this bill/i })
    fireEvent.click(supportBtn)

    await waitFor(() => {
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Couldn't save your vote on SB123")
    })
    root.remove()
  })

  it('announces a priority change even while #root is inert/aria-hidden (overlay open)', async () => {
    hoisted.role = 'admin'
    const { root } = renderSidebar()
    const select = await screen.findByRole('combobox')

    // Simulate an open overlay the same way as the vote test above.
    root.setAttribute('inert', '')
    root.setAttribute('aria-hidden', 'true')

    fireEvent.change(select, { target: { value: 'low' } })

    await waitFor(() => {
      const region = document.querySelector('[aria-live="polite"]')
      expect(region?.textContent).toBe('Priority set to low')
      expect(region?.closest('[aria-hidden="true"]')).toBeNull()
    })

    root.removeAttribute('inert')
    root.removeAttribute('aria-hidden')
    root.remove()
  })
})
