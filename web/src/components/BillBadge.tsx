import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { BILL_BADGE_BASE, BILL_BADGE_MINI, PRIORITY_COLORS } from '../lib/chipStyles'
import { color } from '../styles/tokens'
import { useMultiState } from '../context/ConfigContext'
import { useBillTooltip, type TooltipBill } from './BillHoverTooltip'
import { PrioritySquare } from './PrioritySquare'

interface BillBadgeProps {
  billNumber: string
  /** Raw state; shown only in multi-state instances (gated here, not by callers). */
  state?: string | null
  /** External cross-state hub link for the state token (BillDetail hub only). */
  stateUrl?: string | null
  /** When set, the chip is a Link to this bill route. */
  to?: string
  mini?: boolean
  /** When provided, hovering shows the shared bill tooltip. */
  hoverBill?: Omit<TooltipBill, 'billNumber' | 'state'>
  /** When set, renders a priority square at the chip's trailing edge. */
  priority?: 'high' | 'medium' | 'low' | null
  /** Optional click handler for the Link (when `to` is set); deferred-nav callers
   *  should call e.preventDefault() when they take over navigation. */
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void
}

export function BillBadge({ billNumber, state, stateUrl, to, mini, hoverBill, priority, onClick }: BillBadgeProps) {
  const base = mini ? BILL_BADGE_MINI : BILL_BADGE_BASE
  const multiState = useMultiState()
  const { onEnter, onMove, onLeave, tooltip } = useBillTooltip()
  const showState = multiState && !!state

  useEffect(() => {
    if (!hoverBill) onLeave()
  }, [hoverBill]) // eslint-disable-line react-hooks/exhaustive-deps

  const hoverProps = hoverBill
    ? {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => onEnter({ billNumber, state: showState ? state : undefined, ...hoverBill }, e),
        onMouseMove: (e: React.MouseEvent<HTMLElement>) => onMove({ billNumber, state: showState ? state : undefined, ...hoverBill }, e),
        onMouseLeave: onLeave,
      }
    : {}

  const marker = priority ? (
    <PrioritySquare
      size={mini ? 9 : 11}
      color={PRIORITY_COLORS[priority].dot}
      ring
      style={{ marginLeft: mini ? 8 : 10 }}
    />
  ) : null

  const label = !showState
    ? <>{billNumber}</>
    : stateUrl
      ? (<><a href={stateUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
          style={{ color: color.white, textDecoration: 'underline', textUnderlineOffset: 2, marginRight: 4 }}>{state}</a>{billNumber}</>)
      : <>{state}&nbsp;{billNumber}</>

  const inner = to
    ? <Link to={to} style={{ ...base, textDecoration: 'none' }} onClick={onClick} {...hoverProps}>{label}{marker}</Link>
    : <span style={base} {...hoverProps}>{label}{marker}</span>

  return <>{inner}{tooltip}</>
}
