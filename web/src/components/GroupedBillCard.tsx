import { useState, useRef, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GroupedBillEvents } from '../lib/feedUtils'
import { useVerticalResize, ResizeHandle } from './ResizeHandle'
import { relativeTime, absoluteTime, isUnreadItem } from '../lib/time'
import { billUrl as buildBillUrl } from '../lib/sessionSlug'
import { BillBadge } from './BillBadge'
import { PriorityBadge } from './PriorityBadge'
import { PrioritySquare } from './PrioritySquare'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { buildBillCardModel, CARD_STYLE, type BillCardRow } from '../lib/billCardModel'
import { isModifiedClick } from '../lib/modifierClick'

function MaterialIcon({ name, color, size = 14, fill = 0 }: {
  name: string; color: string; size?: number; fill?: 0 | 1
}) {
  return (
    <span
      className="material-symbols-outlined"
      style={{
        fontSize: size,
        color,
        display: 'inline',
        verticalAlign: 'middle',
        flexShrink: 0,
        lineHeight: 1,
        fontVariationSettings: `'FILL' ${fill}, 'wght' 400, 'GRAD' 0, 'opsz' 24`,
      }}
    >
      {name}
    </span>
  )
}

// ⚠️ Email twin: api/src/lib/digestEmail.ts (renderBillCard) re-implements this
// card in email HTML. Shared bits flow through buildBillCardModel, CARD_STYLE,
// PRIORITY_COLORS and the priority square; layout/markup here is NOT shared, so
// structural changes (header, rows, spacing) won't reach the digest unless you
// update digestEmail too.
export function GroupedBillCard({ group, seenAt = null, currentUserId = null }: { group: GroupedBillEvents; seenAt?: string | null; currentUserId?: string | null }) {
  const navigate = useNavigate()
  const { billId, billNumber, billState, billSessionSlug } = group
  const model = buildBillCardModel(group)
  const [hovered, setHovered] = useState(false)
  const [hoveredHeader, setHoveredHeader] = useState(false)
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)
  const { height, hasResized, handlePointerDown } = useVerticalResize(300, 60)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)

  const rows: BillCardRow[] = model.rows

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) setHasOverflow(el.scrollHeight > el.clientHeight)
  }, [height, rows.length])

  const billUrl = buildBillUrl({ id: billId, state: billState, sessionSlug: billSessionSlug, billNumber })

  function goTo(url: string, e: React.MouseEvent) {
    // ⌘/Ctrl/Shift-click → open in a new tab/window (middle-click handled by
    // onAuxClick). Plain left-click → in-app navigation; the route loader fetches
    // the bill and the router holds this page until it resolves.
    if (isModifiedClick(e)) { window.open(url, '_blank'); return }
    navigate(url)
  }

  return (
    <div>
      <div
        onClick={(e) => goTo(billUrl, e)}
        onAuxClick={(e) => { if (e.button === 1) window.open(billUrl, '_blank') }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: color.white,
        border: `1px solid ${color.borderDefault}`,
        borderRadius: radius.lg,
        marginBottom: 8,
        cursor: 'pointer',
        boxShadow: hovered ? CARD_STYLE.shadowHover : CARD_STYLE.shadow,
        transition: 'box-shadow 0.15s',
        overflow: 'hidden',
      }}
    >
      {/* Chip strip + title + summary — gray bg matching AI summary on BillDetail; darkens on hover like the rows below */}
      <div
        onMouseEnter={() => setHoveredHeader(true)}
        onMouseLeave={() => setHoveredHeader(false)}
        style={{ background: hoveredHeader ? color.surfaceMuted : CARD_STYLE.headerBg }}
      >
        <div style={{ padding: '12px 14px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <BillBadge billNumber={billNumber} state={billState ?? undefined} />
          {model.priority && <PriorityBadge priority={model.priority} />}
        </div>

        <div style={{ padding: '4px 14px 10px' }}>
          <div style={{
            fontFamily: CARD_STYLE.titleFontFamily,
            fontSize: fontSize.base, fontWeight: fontWeight.bold, color: color.textPrimary,
            lineHeight: 1.35,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
            overflow: 'hidden',
          }}>
            {model.title}
          </div>
          {model.summary && (
            <div style={{
              fontFamily: CARD_STYLE.summaryFontFamily,
              fontSize: fontSize.sm, color: color.textSecondary,
              marginTop: 4, lineHeight: 1.45,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical' as const,
              overflow: 'hidden',
            }}>
              {model.summary}
            </div>
          )}
        </div>
      </div>

      {/* Rows — bill_updated rows share gray bg with title/summary; user rows are white */}
      <div ref={scrollRef} style={{ maxHeight: height, overflowY: 'auto' }}>
        {rows.map(row => {
          const isMuted = row.bg === CARD_STYLE.headerBg
          const baseBg = isMuted ? CARD_STYLE.headerBg : color.white
          const hoverBg = isMuted ? color.surfaceMuted : 'rgba(0,0,0,0.04)'
          const unread = isUnreadItem(row.createdAt, row.userId, seenAt, currentUserId)
          return (
            <div
              key={row.key}
              onClick={(e) => { e.stopPropagation(); goTo(billUrl + row.hash, e) }}
              onAuxClick={(e) => { if (e.button === 1) { e.stopPropagation(); window.open(billUrl + row.hash, '_blank') } }}
              onMouseEnter={() => setHoveredRow(row.key)}
              onMouseLeave={() => setHoveredRow(null)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '8px 14px',
                background: hoveredRow === row.key ? hoverBg : baseBg,
                borderTop: `1px solid ${CARD_STYLE.rowBorder}`,
                cursor: 'pointer',
              }}
            >
              {row.square ? (
                <PrioritySquare size={11} color={row.iconColor} style={{ marginTop: 2 }} />
              ) : (
                <MaterialIcon name={row.iconName} color={row.iconColor} fill={row.iconFill} size={14} />
              )}
              <span style={{
                fontSize: fontSize.sm, color: color.textSlate500, flex: 1, minWidth: 0,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical' as const,
                overflow: 'hidden',
                lineHeight: 1.4,
              }}>{row.text}</span>

              {row.showTime && (
                <span title={absoluteTime(row.createdAt)} style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 0 }}>
                  {relativeTime(row.createdAt)}
                </span>
              )}
              {unread && (
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: color.accentBlue,
                  flexShrink: 0, marginTop: 5, marginLeft: 2,
                }} />
              )}
            </div>
          )
        })}
      </div>
      {(hasOverflow || hasResized) && (
        <div onClick={e => e.stopPropagation()}>
          <ResizeHandle onPointerDown={handlePointerDown} />
        </div>
      )}
      </div>
    </div>
  )
}
