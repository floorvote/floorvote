import { useState } from 'react'
import { CHIP_BASE, STATUS_CHIP_MAX_WIDTH, chipOutline } from '../lib/chipStyles'

interface StatusChipProps {
  status: string | null
  onClick?: () => void
  isActive?: boolean
  // id of an element holding a longer explanation of the status
  describedBy?: string
  // Opt-in: cap the chip at STATUS_CHIP_MAX_WIDTH, end a longer label in an
  // ellipsis, and show the full label as hover text. The bill table and the
  // split pane pass it; the bill page and other callers show the label whole.
  capWidth?: boolean
}

// The cap needs the chip to be a block: text-overflow does not apply to the
// text of a flex container, so a capped chip is inline-block, not inline-flex.
const CAPPED = {
  display: 'inline-block',
  boxSizing: 'border-box',
  maxWidth: STATUS_CHIP_MAX_WIDTH,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const

export function StatusChip({ status, onClick, isActive, describedBy, capWidth }: StatusChipProps) {
  const [hovered, setHovered] = useState(false)
  if (!status) return null

  const inner = (
    <span
      aria-describedby={onClick ? undefined : describedBy}
      title={capWidth ? status : undefined}
      style={{ ...CHIP_BASE, whiteSpace: 'nowrap', ...(capWidth ? CAPPED : {}), ...chipOutline(!!isActive, hovered, !!onClick) }}
    >
      {status}
    </span>
  )

  if (!onClick) return inner

  return (
    <button
      aria-describedby={describedBy}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick() }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={capWidth ? status : undefined}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', ...(capWidth ? { maxWidth: STATUS_CHIP_MAX_WIDTH, minWidth: 0 } : {}) }}
    >
      {inner}
    </button>
  )
}
