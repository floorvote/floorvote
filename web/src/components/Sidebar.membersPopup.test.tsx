import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'

// A tenant that calls itself a "chapter" — the roles column header is derived
// from the org noun, so it must read "Chapter roles", not a hardcoded string.
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/auth/me') {
      return {
        id: 'u1', email: 'a@b.c', name: 'Alice Anders', role: 'member', subtitle: null,
        canVote: true, emailDigestEnabled: false, emailWeekAheadEnabled: false,
        lastSeenFeed: null, isLastOwner: false,
      }
    }
    if (path === '/config') return { states: ['NJ'], modules: {}, orgNoun: 'chapter' }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') return { billCount: 1, memberCount: 2, calendarUpcomingCount: 0, calendarUpcomingDays: 30 }
    if (path === '/stats/sidebar') {
      return { priorityBillCount: 0, unvotedPriorityCount: 0, upcomingHearings: [], upcomingHearingsDays: 30, priorityBills: [] }
    }
    if (path === '/users') {
      return [
        { id: 'u2', name: 'Owen Owner', email: 'owen@example.org', subtitle: null, role: 'owner', roles: [{ id: 'r1', name: 'Chair' }] },
        { id: 'u1', name: 'Alice Anders', email: 'alice@example.org', subtitle: null, role: 'member', roles: [] },
      ]
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
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  render(
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
  return root
}

describe('Sidebar members popup', () => {
  it('labels the roles column from the org noun and pins self first', async () => {
    const root = renderSidebar()
    fireEvent.click(await screen.findByRole('button', { name: /2 members/i }))

    const headers = await screen.findAllByRole('columnheader')
    expect(headers.map(h => h.textContent)).toEqual(['Name', 'Role', 'Chapter roles'])

    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0].textContent).toContain('Alice Anders')
    expect(rows[0].textContent).toContain('ME')
    expect(rows[1].textContent).toContain('Owen Owner')
    root.remove()
  })

  it('closes on Escape', async () => {
    const root = renderSidebar()
    fireEvent.click(await screen.findByRole('button', { name: /2 members/i }))
    expect(await screen.findByRole('dialog', { name: 'Members' })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Members' })).toBeNull())
    root.remove()
  })
})
