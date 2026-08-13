/**
 * The FloorVote lockup is a link home, on both surfaces that render it inside
 * the app shell (the sidebar brand row and the mobile top bar). Two things here
 * are easy to regress and neither is visible in a screenshot:
 *
 *  1. The sidebar's lockup must call onClose. On mobile the sidebar is a drawer,
 *     and the drawer's own close-on-route-change effect never fires when the
 *     click doesn't change the route — i.e. exactly when you're already on "/".
 *     Without the explicit onClose the drawer just sits there looking broken.
 *  2. The mobile lockup's size. It shipped at fontSize.base (14px) beside a
 *     22px-wide hamburger, which made the brand read as subordinate to a menu
 *     affordance. The size is asserted so a future edit can't quietly shrink it
 *     back.
 *
 * The link deliberately lives in these two callers rather than inside the shared
 * Wordmark, which also renders on the login and sign-in pages where a link into
 * an authed route would be wrong — the last test pins that.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MobileTopBar } from './MobileTopBar'
import { Sidebar } from './Sidebar'
import { Wordmark } from './Wordmark'
import { AuthProvider } from '../context/AuthContext'
import { ConfigProvider } from '../context/ConfigContext'
import { SidebarRefreshProvider } from '../context/SidebarRefreshContext'
import { NotificationsProvider } from '../context/NotificationsContext'
import { FeedUnreadProvider } from '../context/FeedUnreadContext'
import { fontSize } from '../styles/tokens'

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/auth/me') {
      return {
        id: 'u1', email: 'a@b.c', name: 'A', role: 'member', subtitle: null,
        canVote: true, emailDigestEnabled: false, emailWeekAheadEnabled: false,
        lastSeenFeed: null, isLastOwner: false,
      }
    }
    if (path === '/config') return { states: ['NJ'], modules: {} }
    if (path === '/notifications') return { unreadCount: 0 }
    if (path === '/stats') return { billCount: 0, memberCount: 0, calendarUpcomingCount: 0, calendarUpcomingDays: 30 }
    if (path === '/stats/sidebar') return { priorityBillCount: 0, unvotedPriorityCount: 0, upcomingHearings: [], priorityBills: [] }
    if (path.startsWith('/feed')) return { latestEventAt: null, lastSeenFeed: null }
    return {}
  }),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

function renderSidebar(onClose: () => void, initialPath = '/bills') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <ConfigProvider>
          <SidebarRefreshProvider>
            <NotificationsProvider>
              <FeedUnreadProvider>
                <Sidebar isOpen onClose={onClose} />
              </FeedUnreadProvider>
            </NotificationsProvider>
          </SidebarRefreshProvider>
        </ConfigProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('mobile top bar lockup', () => {
  it('links to the feed at /', () => {
    render(
      <MemoryRouter>
        <MobileTopBar onHamburgerClick={() => {}} />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: /floorvote home/i })
    expect(link.getAttribute('href')).toBe('/')
  })

  it('renders the lockup at the larger xxl size, not the old 14px', () => {
    render(
      <MemoryRouter>
        <MobileTopBar onHamburgerClick={() => {}} />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: /floorvote home/i })
    // Wordmark's root span carries the lockup's font size; the mark height and
    // the mark→name gap are em-based, so this one value scales the whole lockup.
    const lockup = link.querySelector('span') as HTMLElement
    expect(lockup.style.fontSize).toBe(`${fontSize.xxl}px`)
    expect(lockup.style.fontSize).not.toBe(`${fontSize.base}px`)
  })

  it('keeps the hamburger a separate control, not nested in the link', () => {
    render(
      <MemoryRouter>
        <MobileTopBar onHamburgerClick={() => {}} />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: /floorvote home/i })
    const menu = screen.getByRole('button', { name: /open menu/i })
    expect(link.contains(menu)).toBe(false)
  })
})

describe('sidebar brand lockup', () => {
  it('links to the feed at /', async () => {
    renderSidebar(() => {})
    const link = await screen.findByRole('link', { name: /floorvote home/i })
    expect(link.getAttribute('href')).toBe('/')
  })

  it('closes the drawer when clicked', async () => {
    const onClose = vi.fn()
    renderSidebar(onClose)
    const link = await screen.findByRole('link', { name: /floorvote home/i })
    fireEvent.click(link, { button: 0 })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes the drawer even when already on / — the route never changes, so the close-on-navigation effect cannot do it', async () => {
    const onClose = vi.fn()
    renderSidebar(onClose, '/')
    const link = await screen.findByRole('link', { name: /floorvote home/i })
    fireEvent.click(link, { button: 0 })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('the shared Wordmark itself', () => {
  it('renders no link of its own, so the login pages get a plain lockup', () => {
    render(
      <MemoryRouter>
        <Wordmark />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
  })
})
