import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, Link } from 'react-router-dom'
import { useEffect } from 'react'

// Count how many times the Sidebar mounts. A shared layout route mounts it once;
// the old per-route layout remounts it when crossing the admin boundary.
const hoisted = vi.hoisted(() => ({ sidebarMounts: 0 }))

vi.mock('./components/Sidebar', () => ({
  Sidebar: function MockSidebar() {
    useEffect(() => { hoisted.sidebarMounts += 1 }, [])
    return <nav data-testid="sidebar" />
  },
}))
vi.mock('./components/MobileTopBar', () => ({ MobileTopBar: () => null }))

// Light page stubs so the test exercises routing, not page internals.
vi.mock('./pages/Feed', () => ({ Feed: () => <div>feed page</div>, feedLoader: () => null }))
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
