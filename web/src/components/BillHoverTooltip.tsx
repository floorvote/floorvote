import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { billDisplayTitle } from '../../../shared/billTitle'
import { stripMarkdown } from './MarkdownSummary'
import { CHIP_MINI, BILL_BADGE_MINI, PRIORITY_COLORS, TOOLTIP_CHROME } from '../lib/chipStyles'
import { apiFetch } from '../lib/api'

export interface TooltipBill {
  billNumber: string
  billId?: string
  state?: string | null
  title: string
  /** Lets the tooltip label an untitled draft "Untitled draft". Absent = filed. */
  isDraft?: boolean
  summary: string | null
  priority: 'high' | 'medium' | 'low' | null
}

const summaryCache = new Map<string, string | null>()

export function BillHoverTooltip({ bill, cursor }: { bill: TooltipBill; cursor: { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [lazySummary, setLazySummary] = useState<string | null>(bill.summary ?? null)
  const c = bill.priority ? PRIORITY_COLORS[bill.priority] : undefined
  const priorityLabel = c?.label ?? ''

  useEffect(() => {
    if (bill.summary != null) { setLazySummary(bill.summary); return }
    if (!bill.billId) return
    if (summaryCache.has(bill.billId)) { setLazySummary(summaryCache.get(bill.billId) ?? null); return }
    let alive = true
    apiFetch<{ tenantSummary?: string | null }>(`/bills/${bill.billId}`)
      .then(b => { const s = b.tenantSummary ?? null; summaryCache.set(bill.billId!, s); if (alive) setLazySummary(s) })
      .catch(() => {})
    return () => { alive = false }
  }, [bill.billId, bill.summary])

  useLayoutEffect(() => {
    if (ref.current) {
      const w = ref.current.offsetWidth
      const h = ref.current.offsetHeight
      const left = Math.min(cursor.x + 16, window.innerWidth - w - 8)
      // Above the pointer, its bottom edge just over the cursor; below it only when there is no room above.
      const above = cursor.y - 18 - h
      const top = above >= 8 ? above : Math.min(cursor.y + 18, window.innerHeight - h - 8)
      setPos({ left: Math.max(8, left), top: Math.max(8, top) })
    }
  }, [cursor.x, cursor.y, lazySummary, bill.title])

  return createPortal((
    <div ref={ref} style={{
      ...TOOLTIP_CHROME,
      borderRadius: radius.lg,
      position: 'fixed', left: pos?.left ?? cursor.x + 16, top: pos?.top ?? cursor.y - 18,
      visibility: pos === null ? 'hidden' : 'visible',
      zIndex: 1000,
      padding: '10px 12px', maxWidth: 280, pointerEvents: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, marginBottom: 6 }}>
        <span style={BILL_BADGE_MINI}>{bill.state ? `${bill.state} ${bill.billNumber}` : bill.billNumber}</span>
        {c && (
          <span style={{ ...CHIP_MINI, background: c.fill, color: c.text }}>{priorityLabel}</span>
        )}
      </div>
      <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary, lineHeight: 1.35, marginBottom: lazySummary ? 6 : 0, fontFamily: "'Source Serif 4', serif" }}>
        {billDisplayTitle(bill)}
      </div>
      {lazySummary && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.5, fontFamily: "'Source Serif 4', serif" }}>{stripMarkdown(lazySummary)}</div>
      )}
    </div>
  ), document.body)
}

export function useBillTooltip() {
  const [hovered, setHovered] = useState<{ bill: TooltipBill; cursor: { x: number; y: number } } | null>(null)
  const onEnter = (bill: TooltipBill, e: { clientX: number; clientY: number }) =>
    setHovered({ bill, cursor: { x: e.clientX, y: e.clientY } })
  const onMove = (bill: TooltipBill, e: { clientX: number; clientY: number }) =>
    setHovered(prev => (prev ? { bill, cursor: { x: e.clientX, y: e.clientY } } : null))
  const onLeave = () => setHovered(null)
  const tooltip = hovered ? <BillHoverTooltip bill={hovered.bill} cursor={hovered.cursor} /> : null
  return { onEnter, onMove, onLeave, tooltip }
}
