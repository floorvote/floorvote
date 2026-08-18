import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, Link } from 'react-router-dom'
import { useEffect } from 'react'

// Count how many times the Sidebar mounts. A shared layout route mounts it once;
// the old per-route layout remounts it when crossing the admin boundary.
const hoisted = vi.hoisted(() => ({ sidebarMounts: 0 }))

vi.mock('./components/Sidebar', () => ({
  Sidebar: function MockSidebar({ containerRef }: { containerRef: { current: HTMLElement | null } }) {
    useEffect(() => { hoisted.sidebarMounts += 1 }, [])
    return <nav data-testid="sidebar" ref={containerRef} />
  },
}))
// Renders a real hamburger button (rather than null) so the drawer-focus-trap
// tests below can open the mobile drawer the same way a user would.
vi.mock('./components/MobileTopBar', () => ({
  MobileTopBar: ({ onHamburgerClick }: { onHamburgerClick: () => void }) => (
    <button aria-label="Open menu" onClick={onHamburgerClick}>menu</button>
  ),
}))

// Light page stubs so the test exercises routing, not page internals.
vi.mock('./pages/Feed', () => ({
  Feed: () => <div>feed page</div>,
  FeedPane: () => <div>feed page</div>,
  feedLoader: () => null,
}))
vi.mock('./pages/BillList', () => ({
  BillList: () => <div><Link to="/admin/config">go admin</Link><span>bills page</span></div>,
  billListLoader: () => null,
}))
vi.mock('./pages/BillDetail', () => ({ BillDetail: () => <div>detail page</div>, billDetailLoader: () => null }))
vi.mock('./pages/Calendar', () => ({ Calendar: () => <div>calendar page</div>, calendarLoader: () => [] }))
vi.mock('./pages/Profile', () => ({ Profile: () => <div>profile page</div> }))
vi.mock('./pages/admin/Members', () => ({ Members: () => <div>members page</div> }))
vi.mock('./pages/admin/Config', () => ({ Config: () => <div><Link to="/bills">go bills</Link><span>config page</span></div> }))
vi.mock('./pages/admin/Notifications', () => ({ Notifications: () => <div>notifications page</div> }))

// Providers inside AppLayout fetch /config etc.; route auth needs /auth/me.
vi.mock('./lib/api', () => ({
  apiFetch: async (path: string) => {
    if (path === '/auth/me') {
      return { id: 'u1', email: 'a@b.c', name: 'A', role: 'owner', subtitle: null,
        canVote: true, emailDigestEnabled: false, lastSeenFeed: null }
    }
    return {}
  },
  ApiError: class ApiError extends Error {},
}))

import { routes } from './App'
import { AuthProvider } from './context/AuthContext'

beforeEach(() => { hoisted.sidebarMounts = 0 })

describe('AppLayout skip link', () => {
  it('renders a skip-to-content link targeting #main-content, and <main> has that id', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/bills'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
    await screen.findByText('bills page')
    const link = screen.getByRole('link', { name: /skip to (main )?content/i })
    expect(link.getAttribute('href')).toBe('#main-content')
    expect(document.getElementById('main-content')?.tagName).toBe('MAIN')
  })
})

describe('shared layout route (data router)', () => {
  it('keeps the sidebar mounted when crossing the admin boundary', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/bills'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
    expect(await screen.findByText('bills page')).toBeInTheDocument()
    // The mock Sidebar increments this counter in a passive effect, which can
    // flush a tick after 'bills page' commits on a loaded CI runner — poll rather
    // than assert synchronously (fixes an intermittent "expected 0 to be 1").
    await waitFor(() => expect(hoisted.sidebarMounts).toBe(1))

    fireEvent.click(screen.getByText('go admin'))
    expect(await screen.findByText('config page')).toBeInTheDocument()

    // The whole point: navigating into /admin/* must NOT remount the layout/sidebar.
    expect(hoisted.sidebarMounts).toBe(1)

    fireEvent.click(screen.getByText('go bills'))
    expect(await screen.findByText('bills page')).toBeInTheDocument()
    expect(hoisted.sidebarMounts).toBe(1)
  })

  it('resolves the canonical bill-detail route under the data router', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/bills/42'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
    expect(await screen.findByText('detail page')).toBeInTheDocument()
  })
})

describe('AppLayout mobile drawer focus trap', () => {
  it('inerts the top region (skip-link/progress-bar/hamburger/demo-banner) and <main> while the drawer is open, but leaves the Sidebar drawer interactive', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/bills'] })
    render(<AuthProvider><RouterProvider router={router} /></AuthProvider>)
    await screen.findByText('bills page')

    const topRegion = screen.getByTestId('app-top-region')
    const main = document.getElementById('main-content') as HTMLElement
    const sidebar = screen.getByTestId('sidebar')

    // Closed: nothing is inerted.
    expect(topRegion.hasAttribute('inert')).toBe(false)
    expect(main.hasAttribute('inert')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /open menu/i }))

    expect(topRegion.hasAttribute('inert')).toBe(true)
    expect(topRegion.getAttribute('aria-hidden')).toBe('true')
    expect(main.hasAttribute('inert')).toBe(true)
    expect(main.getAttribute('aria-hidden')).toBe('true')
    // The drawer itself (and its dismiss overlay) must stay interactive.
    expect(sidebar.hasAttribute('inert')).toBe(false)
    expect(sidebar.hasAttribute('aria-hidden')).toBe(false)
    expect(document.querySelector('.sidebar-overlay')).not.toBeNull()
    expect(document.querySelector('.sidebar-overlay')?.hasAttribute('inert')).toBe(false)
  })
})
