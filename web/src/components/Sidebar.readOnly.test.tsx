import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'

// Task 8 (global chrome): the sidebar's own vote controls and the admin
// priority select must be disabled — not hidden — when the demo is locked;
// the Feedback entry point is the deliberate exception and is hidden entirely
// in demo mode; and the "Customize widgets" module toggles must stay enabled
// even when the demo is locked (the one write a read-only demo preserves).

const hoisted = vi.hoisted(() => ({ role: 'member' as 'member' | 'admin', demoMode: false, demoLocked: false }))

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: hoisted.demoMode, demoLocked: hoisted.demoLocked }),
}))

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
      return { states: ['NJ'], modules: { 'waiting-for-vote': true, 'upcoming-hearings': false } }
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
    if (/\/bills\/.*\/votes$/.test(path)) return {}
    if (/\/bills\/.*\/priority$/.test(path)) return { priority: 'low' }
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

beforeEach(() => {
  hoisted.role = 'member'
  hoisted.demoMode = false
  hoisted.demoLocked = false
})

describe('Sidebar vote controls when demoLocked', () => {
  it('disables the vote buttons and does not POST/DELETE /bills/:id/votes', async () => {
    hoisted.demoLocked = true
    const { apiFetch } = await import('../lib/api')
    renderSidebar()
    const supportBtn = await screen.findByRole('button', { name: /vote support on this bill/i })
    expect(supportBtn).toBeDisabled()
    fireEvent.click(supportBtn)
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringMatching(/\/votes$/), expect.anything())
  })

  it('leaves the vote buttons enabled when not demoLocked', async () => {
    renderSidebar()
    const supportBtn = await screen.findByRole('button', { name: /vote support on this bill/i })
    expect(supportBtn).toBeEnabled()
  })
})

describe('Sidebar admin priority select when demoLocked', () => {
  it('disables the priority select in the prioritized-bills widget', async () => {
    hoisted.role = 'admin'
    hoisted.demoLocked = true
    renderSidebar()
    expect(await screen.findByRole('combobox', { name: /priority/i })).toBeDisabled()
  })

  it('leaves the priority select enabled when not demoLocked', async () => {
    hoisted.role = 'admin'
    renderSidebar()
    expect(await screen.findByRole('combobox', { name: /priority/i })).toBeEnabled()
  })
})

describe('Sidebar Feedback entry point in demo mode', () => {
  it('is hidden entirely (not merely disabled) when demoMode is true', async () => {
    hoisted.demoMode = true
    hoisted.demoLocked = true
    renderSidebar()
    await screen.findByRole('button', { name: /log out/i })
    expect(screen.queryByRole('button', { name: /feedback/i })).not.toBeInTheDocument()
  })

  it('is visible when not in demo mode', async () => {
    renderSidebar()
    expect(await screen.findByRole('button', { name: /feedback/i })).toBeInTheDocument()
  })
})

describe('Sidebar "Customize widgets" module toggles stay live under demoLocked', () => {
  it('keeps the widget toggle switch enabled even when the demo is locked', async () => {
    hoisted.role = 'admin'
    hoisted.demoLocked = true
    renderSidebar()
    fireEvent.click(await screen.findByRole('button', { name: /customize widgets/i }))
    expect(await screen.findByRole('switch', { name: /toggle upcoming hearings/i })).toBeEnabled()
  })
})
