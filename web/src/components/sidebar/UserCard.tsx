import { Link } from 'react-router-dom'
import { useState } from 'react'
import { displayName } from '../../lib/chipStyles'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import type { User } from './types'

export function UserCard({ user, isActive }: { user: User; isActive?: boolean }) {
  const [hovered, setHovered] = useState(false)
  const userDisplayName = user ? displayName(user) : ''
  const highlighted = isActive || hovered
  return (
    <Link
      to="/profile"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '9px 12px',
        borderRadius: radius.md,
        background: highlighted ? color.bgAmberPriority : color.surfaceSubtle,
        border: `1px solid ${highlighted ? color.borderAmber : color.borderDefault}`,
        textDecoration: 'none',
        transition: 'background 0.1s, border-color 0.1s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.billBadgeNavy, lineHeight: 1.2, marginBottom: user?.subtitle ? 2 : 0 }}>
          {userDisplayName}
        </div>
        {user?.subtitle && (
          <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.3 }}>{user.subtitle}</div>
        )}
      </div>
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke={highlighted ? color.billBadgeNavy : color.textMuted}
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ flexShrink: 0, marginLeft: 8, transition: 'stroke 0.1s' }}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </Link>
  )
}
