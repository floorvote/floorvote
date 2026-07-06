import type React from 'react'
import { color, radius } from '../styles/tokens'
import { SECTION_LABEL, CHROME_TEXT } from '../lib/textStyles'
import { COUNT_BADGE } from '../lib/chipStyles'
import { usePrefersReducedMotion } from '../lib/usePrefersReducedMotion'

const DUR = 160
const EASE = 'cubic-bezier(.4, 0, .2, 1)'

export interface CollapsibleSectionProps {
  /** Anchor id for deep links (e.g. "section-actions"). */
  id?: string
  /** Uppercase section label, e.g. "Actions". */
  label: string
  /** Count badge value; the badge is hidden when undefined. */
  count?: number
  /** Controlled open state. */
  open: boolean
  /** Toggle handler. */
  onToggle: () => void
  /** Draw the top separator border (used for all sections except the first). */
  hasPrev?: boolean
  /** Deep-link flash highlight. */
  flashed?: boolean
  /** Rendered inside the header, after the chevron, only when open (e.g. "most recent first"). */
  openHint?: React.ReactNode
  /** Rendered beside the header button only when closed (e.g. the "Last action:" summary). */
  closedSummary?: React.ReactNode
  /** Section body — always mounted; collapsed via CSS when closed. */
  children: React.ReactNode
}

export function CollapsibleSection({
  id,
  label,
  count,
  open,
  onToggle,
  hasPrev = false,
  flashed = false,
  openHint,
  closedSummary,
  children,
}: CollapsibleSectionProps) {
  const reduce = usePrefersReducedMotion()
  const rowsTransition = reduce ? undefined : `grid-template-rows ${DUR}ms ${EASE}`
  const innerTransition = reduce ? undefined : `opacity ${DUR}ms ease, transform ${DUR}ms ${EASE}`
  const chevTransition = reduce ? undefined : `transform ${DUR}ms ${EASE}`

  return (
    <div
      id={id}
      style={{
        ...(hasPrev ? { borderTop: `1px solid ${color.borderDefault}` } : {}),
        paddingTop: 8,
        paddingBottom: 8,
        boxShadow: flashed ? `0 0 0 3px ${color.borderAmber}` : 'none',
        transition: reduce ? undefined : 'box-shadow 0.6s ease',
        borderRadius: radius.sm,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
        <button
          onClick={onToggle}
          aria-expanded={open}
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', fontFamily: 'inherit', textAlign: 'left', flexShrink: 0 }}
        >
          <span style={SECTION_LABEL}>{label}</span>
          {count != null && <span style={COUNT_BADGE}>{count}</span>}
          <span style={{ ...CHROME_TEXT, display: 'inline-block', transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: chevTransition }}>▼</span>
          {open && openHint}
        </button>
        {!open && closedSummary}
      </div>
      <div
        inert={!open}
        aria-hidden={!open}
        style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: rowsTransition }}
      >
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div
            style={{
              marginTop: 6,
              borderLeft: `2px solid ${color.borderDefault}`,
              paddingLeft: 10,
              marginLeft: 1,
              opacity: open ? 1 : 0,
              transform: open ? 'none' : 'translateY(-4px)',
              transition: innerTransition,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
