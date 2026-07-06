import { useState } from 'react'
import { CHIP_BASE, chipOutline } from '../lib/chipStyles'

interface StatusChipProps {
  status: string | null
  onClick?: () => void
  isActive?: boolean
}

export function StatusChip({ status, onClick, isActive }: StatusChipProps) {
  const [hovered, setHovered] = useState(false)
  if (!status) return null

  const inner = (
    <span style={{ ...CHIP_BASE, whiteSpace: 'nowrap', ...chipOutline(!!isActive, hovered, !!onClick) }}>
      {status}
    </span>
  )

  if (!onClick) return inner

  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex' }}
    >
      {inner}
    </button>
  )
}
