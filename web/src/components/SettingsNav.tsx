import { NavLink } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useEffect, useRef, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { usePrefersReducedMotion } from '../lib/usePrefersReducedMotion'

const MEMBER_TABS = [
  { to: '/profile', label: 'Account' },
]

const ADMIN_TABS = [
  { to: '/admin/config', label: 'Config' },
  { to: '/admin/members', label: 'Members' },
  { to: '/admin/notifications', label: 'Notifications' },
  { to: '/admin/drafts', label: 'Draft bills' },
]

function Tab({ to, label, variant }: { to: string; label: string; variant: 'member' | 'admin' }) {
  const [hovered, setHovered] = useState(false)
  const activeColor = variant === 'admin' ? color.textVioletAdmin : color.billBadgeNavy
  const activeLine = variant === 'admin' ? color.brandViolet : color.accentAmber

  return (
    <NavLink
      to={to}
      end
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={({ isActive }) => ({
        fontSize: fontSize.sm,
        textDecoration: 'none',
        padding: '6px 10px',
        marginBottom: -1,
        display: 'inline-block',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        borderRadius: radius.md,
        fontWeight: isActive ? fontWeight.semibold : fontWeight.normal,
        color: isActive ? activeColor : hovered ? color.tooltipBg : color.textSecondary,
        background: hovered && !isActive ? color.borderDefault : 'transparent',
        borderBottom: isActive ? `2px solid ${activeLine}` : '2px solid transparent',
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        transition: 'background 0.1s, color 0.1s',
      })}
    >
      {label}
    </NavLink>
  )
}

export function SettingsNav() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  const navRef = useRef<HTMLElement | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const reduceMotion = usePrefersReducedMotion()

  // Scroll-position-aware edge fades: show a fade wherever there's more tab
  // row to scroll toward, hide it once that edge is reached. Recomputed on
  // scroll/resize and whenever the tab set changes (isAdmin toggles how many
  // tabs render, which can flip the row from non-overflowing to overflowing).
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return

    const update = () => {
      // 1px epsilon absorbs subpixel scroll-position rounding at either end.
      setCanScrollLeft(nav.scrollLeft > 1)
      setCanScrollRight(nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1)
    }

    update()
    nav.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      nav.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [isAdmin])

  return (
    <div style={{ position: 'relative', marginBottom: 24 }}>
      <nav
        ref={navRef}
        className="settings-nav"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          borderBottom: `1px solid ${color.borderStrong}`,
          // Narrow phones can't fit all tabs (Account · Config/Members/
          // Notifications/Draft bills) — let the row scroll horizontally instead
          // of overflowing. overflowY is explicitly 'clip' (never 'visible', which
          // is the only value the CSS spec would force to match overflowX's
          // 'auto') so the row never becomes independently vertically
          // scrollable too. The nav hugs the tabs with no vertical padding, so
          // a small overflow-clip-margin gives the focused tab's outline ring
          // (2px, offset 2px) room to paint without being clipped.
          overflowX: 'auto',
          overflowY: 'clip',
          overflowClipMargin: 4,
        }}
      >
        {MEMBER_TABS.map(({ to, label }) => (
          <Tab key={to} to={to} label={label} variant="member" />
        ))}

        {isAdmin && (
          <>
            <span style={{
              fontSize: fontSize.xs,
              fontWeight: fontWeight.semibold,
              color: color.textMuted,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              userSelect: 'none',
              cursor: 'default',
              paddingBottom: 2,
              marginLeft: 8,
              flexShrink: 0,
            }}>
              Admin
            </span>
            {ADMIN_TABS.map(({ to, label }) => (
              <Tab key={to} to={to} label={label} variant="admin" />
            ))}
          </>
        )}
      </nav>

      {/* Edge fades: purely decorative scroll affordances, so they're
          aria-hidden and pointer-events:none keeps them from ever stealing a
          tap/click meant for the tab underneath. The opacity transition is
          skipped under prefers-reduced-motion — mobile.css's blanket
          reduced-motion rule only zeroes animation-* durations, not
          transition-*, so this component opts out itself (mirrors
          PinnedShadow.tsx's same reduceMotion check). */}
      <div
        aria-hidden="true"
        data-testid="settings-nav-fade-left"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 24,
          background: `linear-gradient(to right, ${color.surfaceSubtle}, transparent)`,
          opacity: canScrollLeft ? 1 : 0,
          transition: reduceMotion ? 'none' : 'opacity 0.15s ease',
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        data-testid="settings-nav-fade-right"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: 0,
          width: 24,
          background: `linear-gradient(to left, ${color.surfaceSubtle}, transparent)`,
          opacity: canScrollRight ? 1 : 0,
          transition: reduceMotion ? 'none' : 'opacity 0.15s ease',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
