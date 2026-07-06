import type { CSSProperties, ReactNode } from 'react'
import { color, fontSize } from '../styles/tokens'

/**
 * Shared 3-column row used by the Actions, Hearings, and Documents lists on the
 * bill detail page. Column widths are fixed across all three lists so chips and
 * content align both within and across sections.
 */
export const TABULAR_ROW_GRID = '80px 120px 1fr'

interface TabularRowProps {
  date: ReactNode
  chip: ReactNode
  content: ReactNode
  showTopBorder?: boolean
  borderLeftColor?: string
  opacity?: number
}

export function TabularRow({ date, chip, content, showTopBorder, borderLeftColor, opacity }: TabularRowProps) {
  const style: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: TABULAR_ROW_GRID,
    gap: 12,
    fontSize: fontSize.sm,
    padding: '6px 0 6px 8px',
    borderTop: showTopBorder ? `1px solid ${color.surfaceMuted}` : undefined,
    borderLeft: borderLeftColor ? `3px solid ${borderLeftColor}` : '3px solid transparent',
    opacity: opacity ?? 1,
    alignItems: 'start',
  }
  return (
    <div style={style}>
      <div style={{ color: color.textMuted, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        {date}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
        {chip}
      </div>
      <div style={{ minWidth: 0 }}>
        {content}
      </div>
    </div>
  )
}
