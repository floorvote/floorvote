import { useState, useRef, useLayoutEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GroupedBillEvents } from '../lib/feedUtils'
import { useVerticalResize, ResizeHandle } from './ResizeHandle'
import { relativeTime, absoluteTime, isUnreadItem } from '../lib/time'
import { billUrl as buildBillUrl } from '../lib/sessionSlug'
import { BillBadge } from './BillBadge'
import { DraftChip } from './DraftChip'
import { PriorityBadge } from './PriorityBadge'
import { CompactPrioritySelect } from './CompactPrioritySelect'
import { NewMatchChip } from './NewMatchChip'
import { DismissAnnouncement } from './DismissAnnouncement'
import { HoverTooltip } from './HoverTooltip'
import { PrioritySquare } from './PrioritySquare'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { buildBillCardModel, billCardRowText, CARD_STYLE, type BillCardRow } from '../lib/billCardModel'
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
export function GroupedBillCard({ group, seenAt = null, currentUserId = null, isAdmin = false, onPriorityChange, onTriageDismiss }: {
  group: GroupedBillEvents; seenAt?: string | null; currentUserId?: string | null
  /** An admin gets the priority dropdown at the top right, as a Bills list row does; anyone else the read-only badge. */
  isAdmin?: boolean
  /** Called with the priority the dropdown saved (null when cleared), for the card's owner to show it. */
  onPriorityChange?: (priority: 'high' | 'medium' | 'low' | null) => void
  /** Called after the dropdown's Dismiss triaged the bill. */
  onTriageDismiss?: () => void
}) {
  const navigate = useNavigate()
  const { billId, billNumber, billState, billSessionSlug, billIsDraft } = group
  const model = buildBillCardModel(group)
  const [hovered, setHovered] = useState(false)
  const [hoveredHeader, setHoveredHeader] = useState(false)
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)
  const { height, hasResized, handlePointerDown } = useVerticalResize(300, 60)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  const rows: BillCardRow[] = model.rows
  // A companion group's card holds events from several bills: each badge and each row opens its own.
  const cardBills = group.bills ?? [{ billId, billNumber, billState, billSessionSlug, billIsDraft: billIsDraft ?? false }]

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) setHasOverflow(el.scrollHeight > el.clientHeight)
  }, [height, rows.length])

  // A bill-less group never reaches this card (Feed renders it as a FeedActivityRow).
  const billUrl = buildBillUrl({ id: billId ?? undefined, state: billState, sessionSlug: billSessionSlug, billNumber })

  // The bill a row's event is on: the card's own bill unless the row says another.
  const urlOfBill = (id: string | null) => {
    const b = id === null ? undefined : group.bills?.find(x => x.billId === id)
    return b ? buildBillUrl({ id: b.billId ?? undefined, state: b.billState, sessionSlug: b.billSessionSlug, billNumber: b.billNumber }) : billUrl
  }

  // An untriaged new match (see lib/newMatch.ts): an amber state of the priority control, until a priority is set or it is dismissed.
  const isNewMatch = !!group.billNewMatch && !model.priority

  // Top right, where a Bills list row has the same control. The dropdown sits in
  // the card, whose click and middle-click open the bill, so the wrapper keeps
  // both from reaching the card (the select stops its own click, not an auxclick).
  const priorityControl = isAdmin && billId !== null ? (() => {
    const select = (
      <CompactPrioritySelect
        billId={billId}
        current={model.priority}
        onChange={(p) => onPriorityChange?.(p)}
        newMatch={isNewMatch}
        onDismiss={() => { setAnnouncement('Dismissed'); onTriageDismiss?.() }}
        errorAlign="right"
      />
    )
    return (
      <span
        onClick={(e) => e.stopPropagation()}
        onAuxClick={(e) => e.stopPropagation()}
        style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
      >
        <DismissAnnouncement message={announcement} />
        {/* Only a new match's control needs a word: its label alone does not say what to do. */}
        {isNewMatch ? <HoverTooltip text="New keyword match — set a priority or dismiss">{select}</HoverTooltip> : select}
      </span>
    )
  })() : model.priority ? <PriorityBadge priority={model.priority} /> : isNewMatch ? <NewMatchChip /> : null

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
          {/* Draft marker, same pairing as BillRow/BillDetail: the dashed badge
              outline is the visual half, and DraftChip's literal "Draft" is the
              text half — the border alone carries no meaning to a screen reader
              or to anyone who can't distinguish it, so the chip must ship with
              it wherever the dashed variant is used. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
            {group.bills ? cardBills.map(b => (
              <span key={b.billId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <BillBadge
                  billNumber={b.billNumber} state={b.billState ?? undefined} isDraft={b.billIsDraft}
                  to={urlOfBill(b.billId)} onClick={e => e.stopPropagation()}
                />
                {b.billIsDraft && <DraftChip />}
              </span>
            )) : (
              <>
                <BillBadge billNumber={billNumber} state={billState ?? undefined} isDraft={billIsDraft} />
                {billIsDraft && <DraftChip />}
              </>
            )}
          </div>
          {priorityControl}
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
          const unread = isUnreadItem(row.createdAt, row.userId, seenAt, currentUserId)
          return (
            <div
              key={row.key}
              onClick={(e) => { e.stopPropagation(); goTo(urlOfBill(row.billId) + row.hash, e) }}
              onAuxClick={(e) => { if (e.button === 1) { e.stopPropagation(); window.open(urlOfBill(row.billId) + row.hash, '_blank') } }}
              onMouseEnter={() => setHoveredRow(row.key)}
              onMouseLeave={() => setHoveredRow(null)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '8px 14px',
                background: hoveredRow === row.key ? color.surfaceMuted : baseBg,
                borderTop: `1px solid ${CARD_STYLE.rowBorder}`,
                cursor: 'pointer',
              }}
            >
              {row.square ? (
                <PrioritySquare size={11} color={row.iconColor} hollow={row.hollow} style={{ marginTop: 2 }} />
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
              }}>{billCardRowText(row)}</span>

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
