import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import type { FeedEvent } from '../lib/feedUtils'
import { buildActivityRowModel, CARD_STYLE } from '../lib/billCardModel'
import { relativeTime, absoluteTime, isUnreadItem } from '../lib/time'
import { FeedBillList, type FeedListBill, type FeedListEntry, type FeedListPage } from './FeedBillList'
import { PrioritySquare } from './PrioritySquare'
import { color, radius, fontSize } from '../styles/tokens'
import { billsListPath } from '../../../shared/billFilter'

/** A bill the row names, as GET /feed/events/:id/bills sends it: what the shared list's chip and title need. */
type AffectedBill = FeedListBill

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
 * names hundreds of bills costs nothing until someone asks to see them. They are
 * listed by FeedBillList, the list the no-priority row shares, so each chip has
 * the sidebar's hover card.
 */
export function FeedActivityRow({ event, seenAt = null, currentUserId = null }: {
  event: FeedEvent; seenAt?: string | null; currentUserId?: string | null
}) {
  const model = buildActivityRowModel(event)
  const [open, setOpen] = useState(false)
  // The list mounts on first expand and stays, hidden, when collapsed, so a
  // second expand shows what it already loaded.
  const [opened, setOpened] = useState(false)
  const [hovered, setHovered] = useState(false)

  const billIds = (event.metadata as Record<string, unknown>).billIds
  const expandable = Array.isArray(billIds) && billIds.length > 0
  const unread = isUnreadItem(model.createdAt, model.userId, seenAt, currentUserId)

  // The endpoint names every bill at once, so the list is one page.
  const loadPage = useCallback(async (): Promise<FeedListPage> => {
    const data = await apiFetch<{ bills: AffectedBill[] }>(`/feed/events/${event.id}/bills`)
    return { entries: asEntries(data.bills), hasMore: false }
  }, [event.id])

  function toggle() {
    setOpen((was) => !was)
    setOpened(true)
  }

  const content = (
    <>
      {model.square ? (
        <PrioritySquare size={11} color={model.iconColor} hollow={model.hollow} style={{ marginTop: 2 }} />
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

      {opened && (
        <div style={{ display: open ? 'block' : 'none', borderTop: `1px solid ${CARD_STYLE.rowBorder}` }}>
          <FeedBillList loadPage={loadPage} />
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

// A companion group is one policy, so its bills are one entry (#638), listed
// where its first member is. A bill in no group is an entry of its own.
function asEntries(bills: AffectedBill[]): FeedListEntry[] {
  const entries: FeedListEntry[] = []
  const ofGroup = new Map<string, FeedListEntry>()
  for (const b of bills) {
    const entry = b.groupKey ? ofGroup.get(b.groupKey) : undefined
    if (entry) { entry.bills.push(b); continue }
    const created = { key: b.groupKey ? `group:${b.groupKey}` : b.id, bills: [b] }
    entries.push(created)
    if (b.groupKey) ofGroup.set(b.groupKey, created)
  }
  return entries
}
