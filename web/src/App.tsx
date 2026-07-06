import { createBrowserRouter, createRoutesFromElements, RouterProvider, Route, Navigate, Outlet } from 'react-router-dom'
import { color, fontSize } from './styles/tokens'
import { AuthProvider } from './context/AuthContext'
import { DemoProvider, useDemo } from './context/DemoContext'
import { NotificationsProvider } from './context/NotificationsContext'
import { RequireAuth } from './components/RequireAuth'
import { Sidebar } from './components/Sidebar'
import { MobileTopBar } from './components/MobileTopBar'
import { Login } from './pages/Login'
import { AuthVerify } from './pages/AuthVerify'
import { Feed, feedLoader } from './pages/Feed'
import { BillList, billListLoader } from './pages/BillList'
import { BillDetail, billDetailLoader } from './pages/BillDetail'
import { BillDetailError } from './pages/BillDetailError'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { Profile } from './pages/Profile'
import { Members } from './pages/admin/Members'
import { Config } from './pages/admin/Config'
import { Notifications } from './pages/admin/Notifications'
import { Calendar, calendarLoader } from './pages/Calendar'
import { useAuth } from './hooks/useAuth'
import { SidebarRefreshProvider } from './context/SidebarRefreshContext'
import { FeedUnreadProvider } from './context/FeedUnreadContext'
import { ConfigProvider } from './context/ConfigContext'
import { NavProgressBar } from './components/NavProgressBar'
import { useNavPendingCursor } from './hooks/useNavPendingCursor'
import { UnsavedTextProvider } from './lib/unsavedText'
import { useState } from 'react'

function DemoBanner() {
  const { demoMode } = useDemo()
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('demo-banner-dismissed') === 'true')

  if (!demoMode || dismissed) return null

  function dismiss() {
    sessionStorage.setItem('demo-banner-dismissed', 'true')
    setDismissed(true)
  }

  return (
    <div style={{
      position: 'sticky',
      top: 0,
      zIndex: 100,
      background: color.bgInfo,
      borderBottom: `1px solid ${color.tagBorderBlue}`,
      padding: '8px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: fontSize.sm,
      color: color.filterBadgeNavy,
      flexShrink: 0,
    }}>
      <span>You're exploring a demo instance — data resets nightly. The bills are real New Jersey legislation, but the people, county names, and hearing dates are fictional.</span>
      <button
        onClick={dismiss}
        style={{ background: 'none', border: 'none', color: color.filterBadgeNavy, cursor: 'pointer', padding: '0 4px', fontSize: fontSize.lg, lineHeight: 1 }}
        aria-label="Dismiss"
      >×</button>
    </div>
  )
}

function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  useNavPendingCursor()
  return (
    <UnsavedTextProvider>
      <ConfigProvider>
      <DemoProvider>
        <SidebarRefreshProvider>
          <NotificationsProvider>
            <FeedUnreadProvider>
              {/* height comes from the .app-layout CSS rule (100vh → 100dvh) so
                  the shell fits the *visual* viewport on mobile (accounting for
                  the dynamic URL bar) and the document itself never scrolls —
                  keeping the top bar pinned and every page starting at the top. */}
              <div className="app-layout" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: color.surfaceMuted }}>
                <NavProgressBar />
                {/* MobileTopBar lives in the column flow (hidden on desktop via
                    `.mobile-topbar { display:none }`) so it sits above the demo
                    banner rather than overlaying it as a fixed/absolute element. */}
                <MobileTopBar onHamburgerClick={() => setSidebarOpen(true)} />
                <DemoBanner />
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                  {sidebarOpen && (
                    <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
                  )}
                  <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
                  {/* overflowX: 'hidden' — the scroll container is never meant to
                      pan horizontally. Decorative full-bleed elements (e.g. the
                      agenda/feed DateDivider shadow, which intentionally extends
                      ±20px past the content column) would otherwise spill past the
                      viewport and create unwanted left-right scroll once the column
                      nears the viewport width (narrow desktop and mobile). */}
                  <main className="app-main" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', scrollbarGutter: 'stable' }}><Outlet /></main>
                </div>
              </div>
            </FeedUnreadProvider>
          </NotificationsProvider>
        </SidebarRefreshProvider>
      </DemoProvider>
      </ConfigProvider>
    </UnsavedTextProvider>
  )
}

function RequireAdmin() {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ padding: 32 }}>Loading…</div>
  if (!user || (user.role !== 'admin' && user.role !== 'owner')) return <Navigate to="/" replace />
  return <Outlet />
}

// Route tree shared by the live browser router and tests (which build a
// createMemoryRouter from these same route objects). Same tree as the prior
// <Routes>; the v6→v7 data-router swap is intentionally behavior-neutral here —
// no loaders yet. Static segments still outrank the greedy bill param routes.
export const routes = createRoutesFromElements(
  <>
    <Route path="/login" element={<Login />} />
    <Route path="/auth/verify" element={<AuthVerify />} />
    <Route element={<RequireAuth />} errorElement={<RootErrorBoundary />}>
      <Route element={<AppLayout />}>
        <Route index element={<Feed />} loader={feedLoader} />
        <Route path="bills" element={<BillList />} loader={billListLoader} />
        <Route path="bills/:billId" element={<BillDetail />} loader={billDetailLoader} errorElement={<BillDetailError />} />
        <Route path="calendar" element={<Calendar />} loader={calendarLoader} />
        <Route path="profile" element={<Profile />} />
        <Route element={<RequireAdmin />}>
          <Route path="admin" element={<Navigate to="/admin/members" replace />} />
          <Route path="admin/members" element={<Members />} />
          <Route path="admin/config" element={<Config />} />
          <Route path="admin/notifications" element={<Notifications />} />
        </Route>
        {/* Canonical + legacy bill URLs — greedy param routes; React Router
            ranks static segments above these, so order vs. /admin etc. is safe. */}
        <Route path=":state/:sessionSlug/:billNumber" element={<BillDetail />} loader={billDetailLoader} errorElement={<BillDetailError />} />
        <Route path=":sessionSlug/:billNumber" element={<BillDetail />} loader={billDetailLoader} errorElement={<BillDetailError />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </>,
)

const router = createBrowserRouter(routes)

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
