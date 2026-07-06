import { NavLink, Link, useNavigate, useLocation } from 'react-router-dom'
import { billsChipSelection } from '../pages/BillList/billsQuery'
import { useAuth } from '../hooks/useAuth'
import { apiFetch } from '../lib/api'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useRegisterSidebarRefresh } from '../context/SidebarRefreshContext'
import { Wordmark } from './Wordmark'
import { PRODUCT_NAME } from '../../../shared/brand'
import { FeedbackModal } from './FeedbackModal'
import { OperatorBranding } from './OperatorBranding'
import { useBillTooltip, type TooltipBill } from './BillHoverTooltip'
import { useVerticalResize, ResizeHandle } from './ResizeHandle'
import { CompactPrioritySelect } from './CompactPrioritySelect'
import { HoverTooltip } from './HoverTooltip'
import { countBadge } from '../lib/chipStyles'
import { billUrl } from '../lib/sessionSlug'
import { isModuleEnabled } from '../lib/modules'
import { isModifiedClick, maybeOpenInNewTab } from '../lib/modifierClick'
import { useNotifications } from '../context/NotificationsContext'
import { useFeedUnread } from '../context/FeedUnreadContext'
import { useMultiState } from '../context/ConfigContext'
import { NotificationsSlideOver } from './NotificationsSlideOver'
import type { PopPanelHandle } from './ui/PopPanel'
import { PinnedShadow } from './ui/PinnedShadow'
import { useScrolledUnder } from '../hooks/useScrolledUnder'
import { color, radius, fontSize, fontWeight, shadow, BRAND_FONT } from '../styles/tokens'
import { CustomizeSidebar } from './sidebar/CustomizeSidebar'
import { BillBadge } from './BillBadge'
import { PriorityChip } from './sidebar/PriorityChip'
import { VoteButton } from './sidebar/VoteButton'
import { UserCard } from './sidebar/UserCard'
import { MembersPopup } from './sidebar/MembersPopup'
import { HearingRow } from './sidebar/HearingRow'
import { calendarChipLabel, showCustomizeControl } from './sidebar/helpers'
import type { SidebarProps, SidebarData, Stats, Config, Member } from './sidebar/types'

// Re-exported for consumers/tests that import these from the Sidebar module.
export { formatHearingTime } from '../lib/hearingTime'
export { calendarChipLabel, showCustomizeControl }

const DEFAULT_WIDTH = 225
const MIN_WIDTH = 210
const MAX_WIDTH = 400

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { user } = useAuth()
  const { hasUnread, visitHadUnread } = useFeedUnread()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  const location = useLocation()
  const isOnProfile = location.pathname === '/profile'
  const [stats, setStats] = useState<Stats | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [sidebarData, setSidebarData] = useState<SidebarData | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [members, setMembers] = useState<Member[] | null>(null)
  const { unreadCount } = useNotifications()
  const [showNotifications, setShowNotifications] = useState(false)
  const bellRef = useRef<HTMLButtonElement>(null)
  const notifPanelRef = useRef<PopPanelHandle>(null)
  const [showMembersPopup, setShowMembersPopup] = useState(false)
  const customizeBtnRef = useRef<HTMLButtonElement>(null)
  const customizePanelRef = useRef<PopPanelHandle>(null)
  const [showCustomize, setShowCustomize] = useState(false)
  const [customizeRect, setCustomizeRect] = useState<DOMRect | null>(null)
  const { onEnter, onMove, onLeave, tooltip } = useBillTooltip()
  const multiState = useMultiState()
  const sidebarCursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const [navHover, setNavHover] = useState<string | null>(null)
  // Widget-header hover affordances. `unvotedChipHover` takes precedence over
  // `priorityHeaderHover` so the two highlights are mutually exclusive.
  const [priorityHeaderHover, setPriorityHeaderHover] = useState(false)
  const [unvotedChipHover, setUnvotedChipHover] = useState(false)
  const [newChipHover, setNewChipHover] = useState(false)
  const [billsChipHover, setBillsChipHover] = useState(false)
  const [hearingsHeaderHover, setHearingsHeaderHover] = useState(false)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tooltipLastHiddenRef = useRef<number>(0)
  const tooltipActiveRef = useRef<boolean>(false)
  const navigate = useNavigate()
  const billsTo = sessionStorage.getItem('lastBillsUrl') ?? '/bills'
  // Persistent orange highlight on the Bills count chips: lit only when the
  // current view is exactly that chip's canonical destination (all bills vs.
  // new matches). See billsChipSelection.
  const billsChips = billsChipSelection(location.pathname, location.search)
  const membersButtonRef = useRef<HTMLDivElement>(null)
  // Each widget's list is independently resizable. The whole widget area
  // scrolls (see the scroll region in the JSX), so there's no shared budget to
  // juggle between widgets — a handle only clamps its own list to that list's
  // content height, so the grip can never be dragged past the end of content.
  const priorityScrollRef = useRef<HTMLDivElement>(null)
  const {
    height: priorityListMaxHeight,
    hasResized: priorityListHasResized,
    handlePointerDown: handlePriorityListResize,
  } = useVerticalResize(320, 80, () => priorityScrollRef.current?.scrollHeight ?? Infinity)
  const [priorityListHasOverflow, setPriorityListHasOverflow] = useState(false)

  const hearingsScrollRef = useRef<HTMLDivElement>(null)
  const {
    height: hearingsListMaxHeight,
    hasResized: hearingsListHasResized,
    handlePointerDown: handleHearingsListResize,
  } = useVerticalResize(240, 80, () => hearingsScrollRef.current?.scrollHeight ?? Infinity)
  const [hearingsListHasOverflow, setHearingsListHasOverflow] = useState(false)

  // Pinned-header drop shadows for the widgets — shown once each list scrolls.
  // Re-bind when each list appears (the widgets render only after data loads).
  const priorityScrolled = useScrolledUnder(() => priorityScrollRef.current, [sidebarData?.priorityBills.length])
  const hearingsScrolled = useScrolledUnder(() => hearingsScrollRef.current, [sidebarData?.upcomingHearings.length])

  // Persisted sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return parseInt(localStorage.getItem('sidebarWidth') ?? String(DEFAULT_WIDTH)) || DEFAULT_WIDTH } catch { return DEFAULT_WIDTH }
  })

  // Drag-to-resize
  function startResize(e: React.PointerEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth

    function onPointerMove(ev: PointerEvent) {
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + ev.clientX - startX))
      setSidebarWidth(newWidth)
    }

    function onPointerUp() {
      setSidebarWidth(w => { try { localStorage.setItem('sidebarWidth', String(w)) } catch {} return w })
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
  }

  async function handleLogout() {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {})
    navigate('/login')
  }

  async function fetchStats() {
    const data = await apiFetch<Stats>('/stats')
    setStats(data)
  }

  async function fetchSidebarData() {
    const data = await apiFetch<SidebarData>('/stats/sidebar')
    setSidebarData(data)
  }

  async function fetchConfig() {
    const data = await apiFetch<Config>('/config')
    setConfig(data)
    document.title = data.associationName
      ? `${PRODUCT_NAME}: ${data.associationName}`
      : PRODUCT_NAME
  }

  const { forceRefresh: forceRefreshStats } = usePolling(fetchStats, 30_000)
  const { forceRefresh: forceRefreshSidebarData } = usePolling(fetchSidebarData, 30_000)

  useRegisterSidebarRefresh(useCallback(() => {
    forceRefreshStats()
    forceRefreshSidebarData()
    void fetchConfig()
  }, [forceRefreshStats, forceRefreshSidebarData]))

  useLayoutEffect(() => {
    const el = priorityScrollRef.current
    if (el) setPriorityListHasOverflow(el.scrollHeight > el.clientHeight)
  }, [priorityListMaxHeight, sidebarData?.priorityBillCount])

  useLayoutEffect(() => {
    const el = hearingsScrollRef.current
    if (el) setHearingsListHasOverflow(el.scrollHeight > el.clientHeight)
  }, [hearingsListMaxHeight, sidebarData?.upcomingHearings.length])

  useEffect(() => { void fetchStats() }, [])
  useEffect(() => { void fetchSidebarData() }, [])

  // Close mobile drawer whenever the route changes — intentionally omits isOpen/onClose to avoid re-running on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isOpen) onClose() }, [location.pathname])

  useEffect(() => { void fetchConfig().catch(() => {}) }, [])

  async function handleMembersClick() {
    if (isAdmin) {
      navigate('/admin/members')
      onClose()
      return
    }
    if (members === null) {
      const data = await apiFetch<Member[]>('/users').catch(() => [] as Member[])
      setMembers(data)
    }
    setShowMembersPopup(p => !p)
  }

  async function handleSidebarVote(billId: string, pos: 'support' | 'neutral' | 'oppose') {
    if (!sidebarData) return
    const bill = sidebarData.priorityBills.find(b => b.id === billId)
    if (!bill) return
    const prevVote = bill.myVote
    const isToggle = prevVote === pos

    // Optimistic update
    setSidebarData(prev => {
      if (!prev) return prev
      const updatedBills = prev.priorityBills.map(b =>
        b.id === billId ? { ...b, myVote: isToggle ? null : pos } : b
      )
      const unvotedDelta = isToggle ? 1 : prevVote ? 0 : -1
      return { ...prev, priorityBills: updatedBills, unvotedPriorityCount: prev.unvotedPriorityCount + unvotedDelta }
    })
    window.dispatchEvent(new CustomEvent('bill-vote-changed', { detail: { billId, newVote: isToggle ? null : pos, prevVote: prevVote || null } }))

    try {
      if (isToggle) {
        await apiFetch(`/bills/${billId}/votes`, { method: 'DELETE' })
      } else {
        await apiFetch(`/bills/${billId}/votes`, { method: 'POST', body: JSON.stringify({ position: pos }) })
      }
    } catch {
      // Revert on failure
      setSidebarData(prev => {
        if (!prev) return prev
        const revertedBills = prev.priorityBills.map(b =>
          b.id === billId ? { ...b, myVote: prevVote } : b
        )
        const unvotedDelta = isToggle ? -1 : prevVote ? 0 : 1
        return { ...prev, priorityBills: revertedBills, unvotedPriorityCount: prev.unvotedPriorityCount + unvotedDelta }
      })
    }
  }

  function handleSidebarPriorityChange(billId: string, newPriority: 'high' | 'medium' | 'low' | null) {
    setSidebarData(prev => {
      if (!prev) return prev
      if (newPriority === null) {
        return {
          ...prev,
          priorityBills: prev.priorityBills.filter(b => b.id !== billId),
          priorityBillCount: prev.priorityBillCount - 1,
        }
      }
      return {
        ...prev,
        priorityBills: prev.priorityBills.map(b => b.id === billId ? { ...b, priority: newPriority } : b),
      }
    })
  }

  function handleBillTitleEnter(bill: TooltipBill, e: React.MouseEvent<HTMLElement>) {
    sidebarCursorRef.current = { x: e.clientX, y: e.clientY }
    const instant = tooltipActiveRef.current || Date.now() - tooltipLastHiddenRef.current < 600
    if (instant) {
      tooltipActiveRef.current = true
      onEnter(bill, { clientX: sidebarCursorRef.current.x, clientY: sidebarCursorRef.current.y })
    } else {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => {
        tooltipActiveRef.current = true
        onEnter(bill, { clientX: sidebarCursorRef.current.x, clientY: sidebarCursorRef.current.y })
      }, 800)
    }
  }

  function handleBillTitleMove(bill: TooltipBill, e: React.MouseEvent<HTMLElement>) {
    sidebarCursorRef.current = { x: e.clientX, y: e.clientY }
    onMove(bill, e)
  }

  function handleBillTitleLeave() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    if (tooltipActiveRef.current) {
      tooltipLastHiddenRef.current = Date.now()
      tooltipActiveRef.current = false
    }
    onLeave()
  }

  return (
    <aside
      className={`sidebar${isOpen ? ' drawer-open' : ''}`}
      style={{
        position: 'relative',
        width: sidebarWidth,
        height: '100%',
        background: color.white,
        borderRight: `1px solid ${color.borderDefault}`,
        boxShadow: shadow.sidebar,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      {/* Drag-to-resize handle */}
      <div
        onPointerDown={startResize}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 12,
          cursor: 'col-resize',
          zIndex: 10,
          touchAction: 'none',
        }}
      />

      {/* Pinned top: brand + nav (does not scroll) */}
      <div style={{ flexShrink: 0 }}>
      <div style={{ background: color.billBadgeNavy, padding: '16px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Wordmark dark size={fontSize.xl} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              ref={bellRef}
              onClick={() => { if (showNotifications) notifPanelRef.current?.close(); else setShowNotifications(true) }}
              aria-label={unreadCount > 0 ? `${unreadCount} unread mention${unreadCount !== 1 ? 's' : ''}` : 'Notifications'}
              style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
              </svg>
              {unreadCount > 0 && (
                <span style={{
                  position: 'absolute',
                  top: -3,
                  right: -3,
                  background: color.textDeleteRed,
                  color: color.white,
                  fontSize: fontSize.xs,
                  fontWeight: fontWeight.bold,
                  borderRadius: radius.pill,
                  minWidth: 14,
                  height: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 3px',
                  lineHeight: 1,
                }}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            <button
              className="sidebar-close-btn"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'rgba(255,255,255,0.7)',
                fontSize: fontSize.xxl,
                lineHeight: 1,
                padding: 0,
              }}
              aria-label="Close menu"
            >
              ×
            </button>
          </div>
        </div>
        {config?.associationName && (
          <div style={{ fontSize: fontSize.sm, color: color.accentBlueMuted, marginTop: 5, lineHeight: 1.3 }}>
            {config.associationName}
          </div>
        )}
      </div>

      {/* Nav links */}
      <nav style={{ marginTop: 8 }}>
        <NavLink
          to="/"
          end
          onClick={(e) => {
            // ⌘/Ctrl/Shift/middle-click → let the NavLink's <a href> open natively
            // in a new tab/window. Plain click → NavLink navigates and the route
            // loader fetches; just close the mobile sidebar.
            if (isModifiedClick(e)) return
            onClose()
          }}
          onMouseEnter={() => setNavHover('feed')}
          onMouseLeave={() => setNavHover(null)}
          style={({ isActive }) => ({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '7px 10px',
            fontSize: fontSize.base,
            fontWeight: fontWeight.medium,
            color: isActive ? color.billBadgeNavy : color.textSlate,
            background: isActive || navHover === 'feed' ? color.bgAmberPriority : 'transparent',
            textDecoration: 'none',
            borderRadius: radius.md,
            margin: '1px 10px',
          })}
        >
          <span style={{ fontFamily: BRAND_FONT }}>Feed</span>
          {(hasUnread || visitHadUnread) && (
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: color.accentBlue, flexShrink: 0,
            }} />
          )}
        </NavLink>
        <NavLink
          to={billsTo}
          onClick={(e) => {
            if (isModifiedClick(e)) return
            onClose()
          }}
          onMouseEnter={() => setNavHover('bills')}
          onMouseLeave={() => setNavHover(null)}
          style={({ isActive }) => ({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            padding: '7px 10px',
            fontSize: fontSize.base,
            fontWeight: fontWeight.medium,
            color: isActive ? color.billBadgeNavy : color.textSlate,
            background: isActive || navHover === 'bills' ? color.bgAmberPriority : 'transparent',
            textDecoration: 'none',
            borderRadius: radius.md,
            margin: '1px 10px',
          })}
        >
          {() => (
            <>
              <span style={{ fontFamily: BRAND_FONT }}>Bills</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {stats?.billCount != null && (
                  <HoverTooltip text={`${stats.billCount.toLocaleString()} bills available`} maxWidth={220}>
                    {/* Orange (melts into the active row) when you're on the unfiltered
                        /bills view; gray clickable pill otherwise. Click clears all filters. */}
                    <span
                      role="link"
                      tabIndex={0}
                      onClick={(e) => { if (maybeOpenInNewTab(e, '/bills')) return; e.preventDefault(); e.stopPropagation(); onClose(); navigate('/bills') }}
                      onAuxClick={(e) => { maybeOpenInNewTab(e, '/bills') }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClose(); navigate('/bills') } }}
                      onMouseEnter={() => setBillsChipHover(true)}
                      onMouseLeave={() => setBillsChipHover(false)}
                      style={{ ...countBadge(billsChips.allBills || billsChipHover, color.bgAmberPriority), cursor: 'pointer' }}
                    >
                      {stats.billCount.toLocaleString()} bills
                    </span>
                  </HoverTooltip>
                )}
                {isAdmin && (stats?.newMatchesCount ?? 0) > 0 && (
                  <HoverTooltip text={`${stats!.newMatchesCount} new bill${stats!.newMatchesCount === 1 ? '' : 's'} awaiting a priority decision`} maxWidth={220}>
                    <span
                      role="link"
                      tabIndex={0}
                      onClick={(e) => { if (maybeOpenInNewTab(e, '/bills?newMatches=1')) return; e.preventDefault(); e.stopPropagation(); onClose(); navigate('/bills?newMatches=1') }}
                      onAuxClick={(e) => { maybeOpenInNewTab(e, '/bills?newMatches=1') }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClose(); navigate('/bills?newMatches=1') } }}
                      onMouseEnter={() => setNewChipHover(true)}
                      onMouseLeave={() => setNewChipHover(false)}
                      // Orange when newMatches=1 is the only active filter; gray clickable pill otherwise.
                      style={{ ...countBadge(billsChips.newMatches || newChipHover, color.bgAmberPriority), cursor: 'pointer' }}
                    >
                      {stats!.newMatchesCount} new
                    </span>
                  </HoverTooltip>
                )}
              </span>
            </>
          )}
        </NavLink>
        <NavLink
          to="/calendar"
          onClick={(e) => {
            if (isModifiedClick(e)) return
            onClose()
          }}
          onMouseEnter={() => setNavHover('calendar')}
          onMouseLeave={() => setNavHover(null)}
          style={({ isActive }) => ({
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
            padding: '7px 10px',
            fontSize: fontSize.base,
            fontWeight: fontWeight.medium,
            color: isActive ? color.billBadgeNavy : color.textSlate,
            background: isActive || navHover === 'calendar' ? color.bgAmberPriority : 'transparent',
            textDecoration: 'none',
            borderRadius: radius.md,
            margin: '1px 10px',
          })}
        >
          {({ isActive }) => (
            <>
              <span style={{ fontFamily: BRAND_FONT }}>Calendar</span>
              {calendarChipLabel(stats?.calendarUpcomingCount) && (
                <HoverTooltip
                  maxWidth={220}
                  text={(() => {
                    const n = stats?.calendarUpcomingCount ?? 0
                    const d = stats?.calendarUpcomingDays ?? 30
                    return `${n} upcoming event${n === 1 ? '' : 's'} in the next ${d} day${d === 1 ? '' : 's'}`
                  })()}
                >
                  <span style={countBadge(isActive || navHover === 'calendar')}>
                    {calendarChipLabel(stats?.calendarUpcomingCount)}
                  </span>
                </HoverTooltip>
              )}
            </>
          )}
        </NavLink>
      </nav>
      </div>

      {/* Scrollable widget region. Brand+nav above and the user section below
          stay pinned; if the widgets overflow, this region scrolls. Each
          widget's own resize handle controls how tall that widget is here. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 10 }}>

      {/* Priority bills box */}
      {sidebarData !== null && sidebarData.priorityBillCount > 0 && isModuleEnabled(config?.modules, 'waiting-for-vote') && (
        <div style={{ margin: '10px 10px 0', border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, overflow: 'hidden' }}>
          {/* Header row — the whole bar links to the prioritized-bills filter.
              Hovering the bar highlights it and the count chip; the unvoted chip
              is its own link and highlights only when hovered directly. */}
          {(() => {
            const priorityFilter = '/bills?priority=high&priority=medium&priority=low'
            const headerActive = priorityHeaderHover && !unvotedChipHover
            const goToPriority = () => { onClose(); navigate(priorityFilter) }
            return (
              <div
                role="link"
                tabIndex={0}
                onClick={(e) => { if (maybeOpenInNewTab(e, priorityFilter)) return; goToPriority() }}
                onAuxClick={(e) => { maybeOpenInNewTab(e, priorityFilter) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToPriority() } }}
                onMouseEnter={() => setPriorityHeaderHover(true)}
                onMouseLeave={() => setPriorityHeaderHover(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                  padding: '8px 10px',
                  cursor: 'pointer',
                  background: headerActive ? color.bgAmberPriority : color.white,
                  borderBottom: sidebarData.priorityBills.length > 0 ? `1px solid ${color.borderDefault}` : 'none',
                }}
              >
                <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.billBadgeNavy }}>
                  Prioritized bills
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {/* Leftmost chip melts into the orange header on header hover. */}
                  <HoverTooltip text={`${sidebarData.priorityBillCount} prioritized bill${sidebarData.priorityBillCount === 1 ? '' : 's'}`} maxWidth={220}>
                    <span style={countBadge(headerActive)}>
                      {sidebarData.priorityBillCount}
                    </span>
                  </HoverTooltip>
                  {user?.canVote && sidebarData.unvotedPriorityCount > 0 && (
                    <HoverTooltip text={`${sidebarData.unvotedPriorityCount} prioritized bill${sidebarData.unvotedPriorityCount === 1 ? '' : 's'} waiting on your vote`} maxWidth={220}>
                      <Link
                        to={`${priorityFilter}&unvoted=1`}
                        onClick={(e) => { e.stopPropagation(); onClose() }}
                        onMouseEnter={() => setUnvotedChipHover(true)}
                        onMouseLeave={() => setUnvotedChipHover(false)}
                        // Hovered on its own → the chip itself takes the header's orange.
                        style={{ ...countBadge(unvotedChipHover, color.bgAmberPriority), textDecoration: 'none' }}
                      >
                        {sidebarData.unvotedPriorityCount} unvoted
                      </Link>
                    </HoverTooltip>
                  )}
                </div>
              </div>
            )
          })()}

          {/* All priority bills list */}
          {sidebarData.priorityBills.length > 0 && (() => {
            const priorityOrder = { high: 0, medium: 1, low: 2 }
            const sorted = [...sidebarData.priorityBills].sort((a, b) => {
              const aVoted = a.myVote !== null ? 1 : 0
              const bVoted = b.myVote !== null ? 1 : 0
              if (aVoted !== bVoted) return aVoted - bVoted
              const ap = priorityOrder[a.priority] ?? 3
              const bp = priorityOrder[b.priority] ?? 3
              if (ap !== bp) return ap - bp
              return a.billNumber.localeCompare(b.billNumber)
            })
            return (
              <>
                <div ref={priorityScrollRef} style={{ maxHeight: priorityListMaxHeight, overflowY: 'auto' }}>
                  {/* Scroll shadow contained to the list's content width (clears the scrollbar) */}
                  <div style={{ position: 'sticky', top: 0, height: 0, zIndex: 1 }}>
                    <PinnedShadow visible={priorityScrolled} fade={false} />
                  </div>
                  {sorted.map(bill => {
                    const voted = bill.myVote !== null
                    return (
                      <div key={bill.id} style={{ padding: '6px 10px 8px', borderTop: `1px solid ${color.surfaceMuted}`, opacity: user?.canVote && voted ? 0.45 : 1, position: 'relative' }}>
                        <Link
                          to={billUrl({ id: bill.id, state: bill.state, sessionSlug: bill.sessionSlug, billNumber: bill.billNumber })}
                          onClick={() => onClose()}
                          style={{ display: 'block', textDecoration: 'none' }}
                          onMouseEnter={(e) => handleBillTitleEnter({ ...bill, state: multiState ? bill.state : undefined }, e)}
                          onMouseMove={(e) => handleBillTitleMove({ ...bill, state: multiState ? bill.state : undefined }, e)}
                          onMouseLeave={handleBillTitleLeave}
                        >
                          <div style={{ marginBottom: 4 }}>
                            <BillBadge mini billNumber={bill.billNumber} state={bill.state} />
                          </div>
                          <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: color.tooltipBg, fontFamily: "'Source Serif 4', serif", lineHeight: 1.4, display: 'block' }}>
                            {bill.title}
                          </span>
                        </Link>
                        <div style={{ position: 'absolute', top: 6, right: 10 }}>
                          {isAdmin
                            ? <CompactPrioritySelect billId={bill.id} current={bill.priority} onChange={(p) => handleSidebarPriorityChange(bill.id, p)} mini />
                            : <PriorityChip priority={bill.priority} mini />
                          }
                        </div>
                        {user?.canVote && <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                          <VoteButton label="Support" pos="support" current={bill.myVote} onClick={() => handleSidebarVote(bill.id, 'support')} />
                          <VoteButton label="Neutral" pos="neutral" current={bill.myVote} onClick={() => handleSidebarVote(bill.id, 'neutral')} />
                          <VoteButton label="Oppose" pos="oppose" current={bill.myVote} onClick={() => handleSidebarVote(bill.id, 'oppose')} />
                        </div>}
                      </div>
                    )
                  })}
                </div>
                {(priorityListHasOverflow || priorityListHasResized) && <ResizeHandle onPointerDown={handlePriorityListResize} />}
              </>
            )
          })()}
        </div>
      )}

      {/* Upcoming hearings widget */}
      {sidebarData !== null && sidebarData.upcomingHearings.length > 0 && isModuleEnabled(config?.modules, 'upcoming-hearings') && (() => {
        const totalHearings = sidebarData.upcomingHearings.length
        return (
          <div style={{ margin: '10px 10px 0', border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, overflow: 'hidden' }}>
            {/* Header row — the whole bar links to the calendar; hovering
                highlights the bar and the count chip. */}
            <div
              role="link"
              tabIndex={0}
              title="Upcoming hearings for prioritized bills in the next 30 days"
              onClick={(e) => { if (maybeOpenInNewTab(e, '/calendar')) return; onClose(); navigate('/calendar') }}
              onAuxClick={(e) => { maybeOpenInNewTab(e, '/calendar') }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClose(); navigate('/calendar') } }}
              onMouseEnter={() => setHearingsHeaderHover(true)}
              onMouseLeave={() => setHearingsHeaderHover(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 6,
                padding: '8px 10px',
                cursor: 'pointer',
                background: hearingsHeaderHover ? color.bgAmberPriority : color.white,
                borderBottom: `1px solid ${color.borderDefault}`,
              }}
            >
              <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.billBadgeNavy }}>
                Upcoming hearings
              </span>
              {/* Only chip — melts into the orange header on hover. */}
              <span style={countBadge(hearingsHeaderHover)}>
                {totalHearings}
              </span>
            </div>

            <div ref={hearingsScrollRef} style={{ maxHeight: hearingsListMaxHeight, overflowY: 'auto' }}>
              {/* Scroll shadow contained to the list's content width (clears the scrollbar) */}
              <div style={{ position: 'sticky', top: 0, height: 0, zIndex: 1 }}>
                <PinnedShadow visible={hearingsScrolled} fade={false} />
              </div>
              {sidebarData.upcomingHearings.map((h, idx) => (
                <HearingRow
                  key={h.hearingKey}
                  hearing={h}
                  isFirst={idx === 0}
                  onClose={onClose}
                />
              ))}
            </div>

            {(hearingsListHasOverflow || hearingsListHasResized) && <ResizeHandle onPointerDown={handleHearingsListResize} />}
          </div>
        )
      })()}

      </div>{/* end scrollable widget region */}

      {/* Pinned: Customize widgets link (admin only, above user section, does not scroll).
          Quiet gray text link, matching the "N members" / Feedback / Log out utility links. */}
      {showCustomizeControl(user?.role) && (
        <button
          ref={customizeBtnRef}
          type="button"
          onClick={() => {
            if (showCustomize) { customizePanelRef.current?.close(); return }
            setCustomizeRect(customizeBtnRef.current?.getBoundingClientRect() ?? null)
            setShowCustomize(true)
          }}
          style={{
            display: 'block', textAlign: 'left',
            margin: '0 10px 8px', padding: '2px 10px',
            fontSize: fontSize.sm, fontWeight: fontWeight.normal, color: color.textSecondary,
            background: 'none', border: 'none', cursor: 'pointer',
          }}
        >
          Customize widgets
        </button>
      )}
      {showCustomize && (
        <CustomizeSidebar
          ref={customizePanelRef}
          triggerRef={customizeBtnRef}
          modules={config?.modules ?? {}}
          onSaved={() => { void fetchConfig().catch(() => {}); forceRefreshStats(); forceRefreshSidebarData() }}
          onClose={() => setShowCustomize(false)}
          positionStyle={{
            position: 'fixed',
            left: customizeRect ? customizeRect.left : 8,
            bottom: customizeRect ? window.innerHeight - customizeRect.top + 6 : 70,
            width: 300, maxHeight: 'min(70vh, 480px)',
            // `visible` (not `hidden`) so the hearings scope dropdown can open
            // past the popover's edge instead of being clipped inside it.
            display: 'flex', flexDirection: 'column', overflow: 'visible',
          }}
        />
      )}

      {/* Pinned bottom: user section (does not scroll) */}
      <div style={{ flexShrink: 0, borderTop: `1px solid ${color.borderDefault}`, padding: '10px 8px' }}>
        <UserCard user={user ? { name: user.name, email: user.email, subtitle: user.subtitle ?? undefined } : null} isActive={isOnProfile} />
        <div ref={membersButtonRef} style={{ position: 'relative', padding: '6px 4px 2px 12px' }}>
          <button
            onClick={handleMembersClick}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: fontSize.sm, color: color.textSecondary, padding: 0 }}
          >
            {stats?.memberCount ?? '—'} member{stats?.memberCount !== 1 ? 's' : ''}
          </button>
          {showMembersPopup && members !== null && (
            <MembersPopup members={members} currentUserId={user?.id} onClose={() => setShowMembersPopup(false)} />
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, padding: '2px 4px 2px 12px' }}>
          <button
            onClick={() => setShowFeedback(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: fontSize.sm, color: color.textSecondary, padding: 0 }}
          >
            Feedback
          </button>
          <button
            onClick={config?.demoLocked ? undefined : handleLogout}
            disabled={config?.demoLocked}
            style={{ background: 'none', border: 'none', cursor: config?.demoLocked ? 'not-allowed' : 'pointer', fontSize: fontSize.sm, color: config?.demoLocked ? color.borderStrong : color.textSecondary, padding: 0 }}
          >
            Log out
          </button>
        </div>
      </div>

      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
      {tooltip}
      {showNotifications && (
        <NotificationsSlideOver
          ref={notifPanelRef}
          triggerRef={bellRef}
          onClose={() => setShowNotifications(false)}
        />
      )}

      {/* Operator branding + data attribution (pinned) */}
      <OperatorBranding />
    </aside>
  )
}
