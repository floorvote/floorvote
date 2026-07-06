import { useState } from 'react'
import { chipOutline } from '../lib/chipStyles'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

interface RelevanceChipProps {
  score: number | null
  showLabel?: boolean
  label?: string
  onClick?: () => void
  isActive?: boolean
}

export function RelevanceChip({ score, showLabel, label = 'topic relevance', onClick, isActive }: RelevanceChipProps) {
  const [hovered, setHovered] = useState(false)
  if (score == null) return null

  const chip = (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
      padding: '3px 10px', borderRadius: radius.sm,
      border: `1px solid ${color.borderAmber}`, background: color.bgAmberPriority, color: color.textAmberDark,
      whiteSpace: 'nowrap',
      ...chipOutline(!!isActive, hovered, !!onClick),
    }}>
      {score}/10{showLabel ? ` ${label}` : ''}
    </span>
  )

  if (onClick) {
    return (
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick() }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex' }}
      >
        {chip}
      </button>
    )
  }

  return chip
}
