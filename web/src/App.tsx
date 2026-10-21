import { createBrowserRouter, createRoutesFromElements, RouterProvider, Route, Navigate, Outlet, useLocation, useMatches } from 'react-router-dom'
import { color, fontSize } from './styles/tokens'
import { AuthProvider } from './context/AuthContext'
import { DemoProvider, useDemo } from './context/DemoContext'
import { NotificationsProvider } from './context/NotificationsContext'
import { RequireAuth } from './components/RequireAuth'
import { LoadingState } from './components/LoadingState'
import { Sidebar } from './components/Sidebar'
import { MobileTopBar } from './components/MobileTopBar'
import { Login } from './pages/Login'
import { AuthVerify } from './pages/AuthVerify'
import { MuteBillLink } from './pages/MuteBillLink'
import { ConfirmEmailChange, EmailChangeNotMe } from './pages/ConfirmEmailChange'
import { FeedPane, feedLoader } from './pages/Feed'
import { BillList, billListLoader } from './pages/BillList'
import { BillDetail, billDetailLoader } from './pages/BillDetail'
import { BillDetailError } from './pages/BillDetailError'
import { BillListPane, BILL_SPLIT_MIN_WIDTH } from './pages/BillList/BillListPane'
import { useIsBreakpoint } from './hooks/use-is-breakpoint'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { Profile } from './pages/Profile'
import { Members } from './pages/admin/Members'
import { Config } from './pages/admin/Config'
import { Notifications } from './pages/admin/Notifications'
import { CalendarEventsMoved } from './pages/admin/CalendarEventsMoved'
import { Calendar, calendarLoader } from './pages/Calendar'
import { useAuth } from './hooks/useAuth'
import { SidebarRefreshProvider } from './context/SidebarRefreshContext'
import { FeedUnreadProvider } from './context/FeedUnreadContext'
import { ConfigProvider, ConfigContext } from './context/ConfigContext'
import { NavProgressBar } from './components/NavProgressBar'
import { useNavPendingCursor } from './hooks/useNavPendingCursor'
import { UnsavedTextProvider } from './lib/unsavedText'
import { legalDocs, hasTerms, hasPrivacy } from './lib/legalDocs'
import { useFocusTrap } from './lib/useFocusTrap'
import { billsListPath } from '../../shared/billFilter'
import { useState, useRef, useContext, lazy, Suspense } from 'react'

// Exported for App.demoBanner.test.tsx, which pins the "render nothing until
// config resolves" guard directly against DemoContext/ConfigContext rather
// than through a full App/router mount.
export function DemoBanner() {
  const { demoMode } = useDemo()
  const { config } = useContext(ConfigContext)
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('demo-banner-dismissed') === 'true')

  const text = config?.demoBanner
  // Render nothing (not fallback copy) until config resolves — otherwise a
  // tenant would flash the wrong banner text while GET /config is still in
  // flight.
  if (!demoMode || dismissed || !text) return null

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
      color: color.linkBlue,
      flexShrink: 0,
    }}>
      <span>{text}</span>
      <button
        onClick={dismiss}
        style={{ background: 'none', border: 'none', color: color.linkBlue, cursor: 'pointer', padding: '0 4px', fontSize: fontSize.lg, lineHeight: 1 }}
        aria-label="Dismiss"
      >×</button>
    </div>
  )
}

function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  // Covers everything above the inner flex row (skip-link, nav progress bar,
  // mobile hamburger, demo banner) — see the wrapping div below.
  const topRef = useRef<HTMLDivElement>(null)
  useNavPendingCursor()
  // Bill routes carry `handle.billListPane`. On a wide viewport they get the
  // Bills list beside them, rendered here rather than in the route so it stays
  // mounted (and keeps its scroll) as the reader moves from bill to bill.
  const onBillRoute = useMatches().some(m => (m.handle as { billListPane?: boolean } | undefined)?.billListPane)
  const wide = useIsBreakpoint('min', BILL_SPLIT_MIN_WIDTH)
  // Trap focus in the mobile drawer while it's open (sidebarOpen is only ever
  // toggled true on mobile — the desktop sidebar is always visible, so this is
  // a no-op there and the desktop sidebar stays fully tabbable). The drawer
  // renders in-tree inside #root (unlike Dialog/PopPanel, which portal to
  // document.body), so inerting the default #root would inert the drawer
  // itself; inertTarget instead inerts the content around it — both the
  // column-top region (topRef) and <main> (mainRef) — which are siblings of
  // the drawer, not ancestors, so inerting them leaves the drawer (and its
  // dismiss overlay) interactive.
  useFocusTrap({
    active: sidebarOpen,
    containerRef: sidebarRef,
    onEscape: () => setSidebarOpen(false),
    initialFocus: 'first',
    inertTarget: [topRef, mainRef],
  })
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
                {/* display:'contents' adds no layout box of its own — the
                    children remain direct flex items of .app-layout, so this
                    wrapper is a zero-visual-impact hook for the drawer's focus
                    trap to inert this whole region at once. */}
                <div style={{ display: 'contents' }} ref={topRef} data-testid="app-top-region">
                  <a className="skip-link" href="#main-content">Skip to main content</a>
                  <NavProgressBar />
                  {/* MobileTopBar lives in the column flow (hidden on desktop via
                      `.mobile-topbar { display:none }`) so it sits above the demo
                      banner rather than overlaying it as a fixed/absolute element. */}
                  <MobileTopBar onHamburgerClick={() => setSidebarOpen(true)} />
                  <DemoBanner />
                </div>
                <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                  {sidebarOpen && (
                    <div className="sidebar-overlay" role="presentation" onClick={() => setSidebarOpen(false)} />
                  )}
                  <Sidebar containerRef={sidebarRef} isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
                  {onBillRoute && wide && <BillListPane />}
                  {/* overflowX: 'hidden' — the scroll container is never meant to
                      pan horizontally. Decorative full-bleed elements (e.g. the
                      agenda/feed DateDivider shadow, which intentionally extends
                      ±20px past the content column) would otherwise spill past the
                      viewport and create unwanted left-right scroll once the column
                      nears the viewport width (narrow desktop and mobile).
                      position: 'relative' — makes the scroll container the
                      containing block for absolutely positioned content. Without
                      it, a visually hidden live region with no positioned
                      ancestor is placed against the page, far down a long page,
                      and the document scrolls too: a second scrollbar. */}
                  <main ref={mainRef} id="main-content" className="app-main" style={{ flex: 1, position: 'relative', overflowY: 'auto', overflowX: 'hidden', scrollbarGutter: 'stable' }}><Outlet /></main>
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
  const { user, loading, authProgress } = useAuth()
  if (loading) return <LoadingState variant="full" progress={authProgress} />
  if (!user || (user.role !== 'admin' && user.role !== 'owner')) return <Navigate to="/" replace />
  return <Outlet />
}

const LegalPage = lazy(() => import('./pages/LegalPage').then((m) => ({ default: m.LegalPage })))

// Renders while the router is uninitialized on a cold load. LoadingState's
// first tier is empty for 500ms, which is what keeps this from flashing on a
// healthy load — and what makes a deep link to /bills legible during an
// outage, since billListLoader has no 400ms race like feedLoader's: it blocks
// for however long its 10s-deadline attempts keep retrying.
function RootHydrateFallback() {
  return <LoadingState variant="full" progress={{ current: null }} />
}

function AccountMoved() {
  const { search, hash } = useLocation()
  return <Navigate to={{ pathname: '/account', search, hash }} replace />
}

// Marks the bill detail routes for AppLayout's split pane (BillListPane).
const BILL_ROUTE_HANDLE = { billListPane: true }

// Route tree shared by the live browser router and tests (which build a
// createMemoryRouter from these same route objects). Same tree as the prior
// <Routes>; the v6→v7 data-router swap is intentionally behavior-neutral here —
// no loaders yet. Static segments still outrank the greedy bill param routes.
export const routes = createRoutesFromElements(
  <Route HydrateFallback={RootHydrateFallback}>
    <Route path="/login" element={<Login />} />
    <Route path="/auth/verify" element={<AuthVerify />} />
    {/* No session: a reply email's signed mute link (#355). */}
    <Route path="/mute-bill" element={<MuteBillLink />} />
    <Route path="/auth/confirm-email" element={<ConfirmEmailChange />} />
    <Route path="/auth/not-me" element={<EmailChangeNotMe />} />
    {hasTerms && (
      <Route path="/terms" element={
        <Suspense fallback={null}><LegalPage title="Terms of Use" content={legalDocs.terms!} /></Suspense>
      } />
    )}
    {hasPrivacy && (
      <Route path="/privacy" element={
        <Suspense fallback={null}><LegalPage title="Privacy Policy" content={legalDocs.privacy!} /></Suspense>
      } />
    )}
    <Route element={<RequireAuth />} errorElement={<RootErrorBoundary />}>
      <Route element={<AppLayout />}>
        <Route index element={<FeedPane />} loader={feedLoader} />
        <Route path="bills" element={<BillList />} loader={billListLoader} />
        <Route path="bills/:billId" element={<BillDetail />} loader={billDetailLoader} errorElement={<BillDetailError />} handle={BILL_ROUTE_HANDLE} />
        <Route path="calendar" element={<Calendar />} loader={calendarLoader} />
        <Route path="account" element={<Profile />} />
        {/* The Account page's old URL. Sent emails and their List-Unsubscribe
            headers link to /profile#<setting>, so the hash and query carry over. */}
        <Route path="profile" element={<AccountMoved />} />
        {/* The Settings → Draft bills page is retired: drafts are created from
            the Bills page and listed there under the Drafts filter, so old
            links and bookmarks land on that filtered list. Outside
            RequireAdmin on purpose — the Drafts filter is on the Bills page
            for every signed-in member, and a member's old link should reach
            it rather than bounce to the feed. Still inside RequireAuth, so a
            signed-out visitor goes to login first. */}
        <Route path="admin/drafts" element={<Navigate to={billsListPath({ drafts: true })} replace />} />
        <Route element={<RequireAdmin />}>
          <Route path="admin" element={<Navigate to="/admin/members" replace />} />
          <Route path="admin/members" element={<Members />} />
          <Route path="admin/config" element={<Config />} />
          <Route path="admin/notifications" element={<Notifications />} />
          <Route path="admin/calendar-events" element={<CalendarEventsMoved />} />
        </Route>
        {/* Canonical + legacy bill URLs — greedy param routes; React Router
            ranks static segments above these, so order vs. /admin etc. is safe. */}
        <Route path=":state/:sessionSlug/:billNumber" element={<BillDetail />} loader={billDetailLoader} errorElement={<BillDetailError />} handle={BILL_ROUTE_HANDLE} />
        <Route path=":sessionSlug/:billNumber" element={<BillDetail />} loader={billDetailLoader} errorElement={<BillDetailError />} handle={BILL_ROUTE_HANDLE} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route>,
)

const router = createBrowserRouter(routes)

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
