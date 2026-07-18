import { NavLink } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'

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

  return (
    <nav className="settings-nav" style={{
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      borderBottom: `1px solid ${color.borderStrong}`,
      marginBottom: 24,
      // Narrow phones can't fit all tabs (Account · Config/Members/
      // Notifications/Draft bills) — let the row scroll horizontally instead of overflowing.
      overflowX: 'auto',
    }}>
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
  )
}
