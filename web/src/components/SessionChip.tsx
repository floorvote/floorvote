import { useState } from 'react'
import { CHIP_BASE, chipOutline } from '../lib/chipStyles'

interface SessionChipProps {
  session: string | null
  onClick?: () => void
  isActive?: boolean
}

export function SessionChip({ session, onClick, isActive }: SessionChipProps) {
  const [hovered, setHovered] = useState(false)
  if (!session) return null

  const chipStyle = { ...CHIP_BASE, minWidth: 0 }

  if (!onClick) {
    return (
      <span style={chipStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {session}
        </span>
      </span>
    )
  }

  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        display: 'inline-flex', maxWidth: '100%', minWidth: 0,
        borderRadius: CHIP_BASE.borderRadius,
        ...chipOutline(!!isActive, hovered, true),
      }}
    >
      <span style={chipStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {session}
        </span>
      </span>
    </button>
  )
}
