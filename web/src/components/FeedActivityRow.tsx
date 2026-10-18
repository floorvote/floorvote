import { useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import type { FeedEvent } from '../lib/feedUtils'
import { buildActivityRowModel, CARD_STYLE } from '../lib/billCardModel'
import { relativeTime, absoluteTime, isUnreadItem } from '../lib/time'
import { billUrl } from '../lib/sessionSlug'
import { billDisplayTitle } from '../../../shared/billTitle'
import { BillBadge } from './BillBadge'
import { DraftChip } from './DraftChip'
import { PrioritySquare } from './PrioritySquare'
import { color, radius, fontSize } from '../styles/tokens'
import { billsListPath } from '../../../shared/billFilter'

type AffectedBill = {
  id: string; billNumber: string; title: string
  state: string | null; sessionSlug: string | null; isDraft: boolean
}
type Load = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'done'; bills: AffectedBill[] }

function MaterialIcon({ name, color: c, size = 14, fill = 0 }: { name: string; color: string; size?: number; fill?: 0 | 1 }) {
  return (
    <span
      aria-hidden="true"
      className="material-symbols-outlined"
      style={{
        fontSize: size, color: c, display: 'inline', verticalAlign: 'middle', flexShrink: 0, lineHeight: 1,
        fontVariationSettings: `'FILL' ${fill}, 'wght' 400, 'GRAD' 0, 'opsz' 24`,
      }}
    >
      {name}
    </span>
  )
}

/**
 * The Feed's card for an event about no single bill, such as a bulk edit or the
 * day's new matches: one activity row, expandable to the bills it names. A bill-less event has no bill
 * to head a card with, so this is not a GroupedBillCard. The bills load on first
 * expand (GET /feed/events/:id/bills), not with the feed, so a bulk edit that
 * names hundreds of bills costs nothing until someone asks to see them.
 */
export function FeedActivityRow({ event, seenAt = null, currentUserId = null }: {
  event: FeedEvent; seenAt?: string | null; currentUserId?: string | null
}) {
  const model = buildActivityRowModel(event)
  const [open, setOpen] = useState(false)
  const [load, setLoad] = useState<Load>({ status: 'idle' })
  const [hovered, setHovered] = useState(false)

  const billIds = (event.metadata as Record<string, unknown>).billIds
  const expandable = Array.isArray(billIds) && billIds.length > 0
  const unread = isUnreadItem(model.createdAt, model.userId, seenAt, currentUserId)

  async function fetchBills() {
    setLoad({ status: 'loading' })
    try {
      const data = await apiFetch<{ bills: AffectedBill[] }>(`/feed/events/${event.id}/bills`)
      setLoad({ status: 'done', bills: data.bills })
    } catch {
      setLoad({ status: 'error' })
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && load.status === 'idle') void fetchBills()
  }

  const content = (
    <>
      {model.square ? (
        <PrioritySquare size={11} color={model.iconColor} style={{ marginTop: 2 }} />
      ) : (
        <MaterialIcon name={model.iconName} color={model.iconColor} fill={model.iconFill} />
      )}
      <span style={{ fontSize: fontSize.sm, color: color.textSlate500, flex: 1, minWidth: 0, lineHeight: 1.4, textAlign: 'left' }}>
        {model.text}
      </span>
      <span title={absoluteTime(model.createdAt)} style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 0 }}>
        {relativeTime(model.createdAt)}
      </span>
      {unread && (
        <span data-unread style={{ width: 8, height: 8, borderRadius: '50%', background: color.accentBlue, flexShrink: 0, marginTop: 5, marginLeft: 2 }} />
      )}
      {expandable && <MaterialIcon name={open ? 'expand_less' : 'expand_more'} color={color.textMuted} size={18} />}
    </>
  )
  const rowStyle = {
    display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '10px 14px', boxSizing: 'border-box',
    background: hovered && expandable ? color.surfaceMuted : color.white, border: 'none', font: 'inherit',
  } as const

  return (
    <div
      style={{
        background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg,
        marginBottom: 8, boxShadow: CARD_STYLE.shadow, overflow: 'hidden',
      }}
    >
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{ ...rowStyle, cursor: 'pointer' }}
        >
          {content}
        </button>
      ) : (
        <div style={rowStyle}>{content}</div>
      )}

      {open && (
        <div style={{ borderTop: `1px solid ${CARD_STYLE.rowBorder}` }}>
          {load.status === 'loading' && <Note>Loading…</Note>}
          {load.status === 'error' && (
            <Note>
              Couldn’t load the bills.{' '}
              <button type="button" onClick={() => void fetchBills()} style={{ all: 'unset', cursor: 'pointer', color: color.linkBlue, textDecoration: 'underline' }}>
                Try again
              </button>
            </Note>
          )}
          {load.status === 'done' && load.bills.length === 0 && <Note>These bills are no longer available.</Note>}
          {load.status === 'done' && load.bills.map((b, i) => (
            <BillLink key={b.id} bill={b} first={i === 0} />
          ))}
          {event.type === 'new_matches' && (
            <Link
              to={billsListPath({ newMatches: true })}
              style={{
                display: 'block', padding: '8px 14px', fontSize: fontSize.sm, color: color.linkBlue, textDecoration: 'none',
                borderTop: `1px solid ${CARD_STYLE.rowBorder}`,
              }}
            >
              See all new matches
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '10px 14px', fontSize: fontSize.sm, color: color.textMuted }}>{children}</div>
}

function BillLink({ bill, first }: { bill: AffectedBill; first: boolean }) {
  const [hovered, setHovered] = useState(false)
  const title = billDisplayTitle({ title: bill.title, isDraft: bill.isDraft })
  return (
    <Link
      to={billUrl({ id: bill.id, state: bill.state, sessionSlug: bill.sessionSlug, billNumber: bill.billNumber })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', textDecoration: 'none',
        background: hovered ? color.surfaceMuted : color.white,
        borderTop: first ? 'none' : `1px solid ${CARD_STYLE.rowBorder}`,
      }}
    >
      <BillBadge billNumber={bill.billNumber} state={bill.state ?? undefined} isDraft={bill.isDraft} mini />
      {bill.isDraft && <DraftChip />}
      <span style={{
        fontSize: fontSize.sm, color: color.textPrimary, flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{title}</span>
    </Link>
  )
}
