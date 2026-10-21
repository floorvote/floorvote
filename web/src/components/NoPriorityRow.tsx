import { useCallback, useState } from 'react'
import { apiFetch } from '../lib/api'
import type { FeedEvent } from '../lib/feedUtils'
import { CARD_STYLE } from '../lib/billCardModel'
import { CHROME_TEXT } from '../lib/textStyles'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { FeedBillChip, FeedBillList, type FeedListBill, type FeedListEntry, type FeedListPage, type FeedListPriority } from './FeedBillList'

function MaterialIcon({ name, color: c, size = 14 }: { name: string; color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="material-symbols-outlined"
      style={{ fontSize: size, color: c, lineHeight: 1, flexShrink: 0, fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24" }}
    >
      {name}
    </span>
  )
}

const HEADER_BUTTON = {
  display: 'inline-flex', alignItems: 'center', minHeight: 40, padding: 0, border: 'none', background: 'none',
  font: 'inherit', cursor: 'pointer', textAlign: 'left',
} as const

/**
 * The feed's no-priority updates row (see **No-priority updates row** in
 * CONTEXT.md): the day's legislative activity on analyzed bills with no
 * priority, as one row. Collapsed, it says how many bills moved and shows the
 * two most relevant as chips; expanded, it lists them all, a page at a time.
 * GET /feed sends the count and the two (metadata.count, metadata.firstBills).
 * It has no time, since the date divider above it says the day, and no unread
 * mark, since it never lights the Feed dot.
 *
 * An admin sets a priority from each listed bill's dropdown, and a member sees
 * the read-only label. A bill given a priority leaves the list, and `onPrioritized`
 * hands its owner what is left, which `rowAfterPrioritized` turns into the
 * row's new count and chips, so the row shrinks in place until the feed next loads.
 */
export function NoPriorityRow({ event, isAdmin = false, onPrioritized, onDismissed }: {
  event: FeedEvent
  isAdmin?: boolean
  onPrioritized?: FeedListPriority['onPrioritized']
  onDismissed?: FeedListPriority['onDismissed']
}) {
  const meta = event.metadata as { count?: unknown; firstBills?: unknown }
  const count = Number(meta.count ?? 0)
  const firstBills = (Array.isArray(meta.firstBills) ? meta.firstBills : []) as FeedListBill[]
  const [open, setOpen] = useState(false)
  // The list mounts on first expand and stays, hidden, when collapsed, so a
  // second expand shows what it already loaded.
  const [opened, setOpened] = useState(false)
  const [hovered, setHovered] = useState(false)

  const loadPage = useCallback(
    (page: number, dropped: number) =>
      apiFetch<FeedListPage>(`/feed/events/${event.id}/bills?page=${page}${dropped > 0 ? `&removed=${dropped}` : ''}`),
    [event.id],
  )
  const priority: FeedListPriority = {
    isAdmin,
    onPrioritized: (entry, p, remaining) => onPrioritized?.(entry, p, remaining),
    onDismissed: (entry) => onDismissed?.(entry),
  }

  function toggle() {
    setOpen((was) => !was)
    setOpened(true)
  }

  const more = count - firstBills.slice(0, 2).length
  return (
    <div
      data-no-priority-row
      style={{
        background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg,
        marginBottom: 8, boxShadow: CARD_STYLE.shadow, overflow: 'hidden',
      }}
    >
      {/* The label's button toggles the list and carries its name and state for keyboards and screen
          readers. The chips beside it are links of their own, and the rest of the header, out to the
          chevron, is a second target for the pointer, left out of the tab order and the accessibility tree. */}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 14px',
          background: hovered ? color.surfaceMuted : color.white,
        }}
      >
        <button type="button" aria-expanded={open} onClick={toggle} style={{ ...HEADER_BUTTON, gap: 8 }}>
          <MaterialIcon name="gavel" color={color.textSecondary} />
          <span style={{ fontSize: fontSize.sm, color: color.textSlate500, lineHeight: 1.4 }}>
            Updates on {count} {count === 1 ? 'bill' : 'bills'} with no priority
          </span>
        </button>
        {firstBills.slice(0, 2).map((b) => (
          <span key={b.id} style={{ display: 'inline-flex' }}>
            {/* The header has no room for a visible Draft chip, so a draft's chip says so to a screen reader. */}
            <FeedBillChip bill={b} draftSrLabel />
          </span>
        ))}
        {more > 0 && <span style={{ ...CHROME_TEXT, fontWeight: fontWeight.semibold }}>+{more}</span>}
        <button type="button" tabIndex={-1} aria-hidden="true" onClick={toggle} style={{ ...HEADER_BUTTON, flex: 1, justifyContent: 'flex-end' }}>
          <MaterialIcon name={open ? 'expand_less' : 'expand_more'} color={color.textMuted} size={18} />
        </button>
      </div>

      {opened && (
        <div style={{ display: open ? 'block' : 'none', borderTop: `1px solid ${CARD_STYLE.rowBorder}` }}>
          <FeedBillList loadPage={loadPage} priority={priority} />
        </div>
      )}
    </div>
  )
}

/**
 * The row's metadata once `entry` has left its list: one fewer bill, and the two
 * chips the list's remaining entries now lead with. The list holds the row from
 * its first entry, so its first two remaining entries are the row's two most
 * relevant; with fewer than two loaded, the chips it had less the leaver's.
 */
export function rowAfterPrioritized(meta: FeedEvent['metadata'], entry: FeedListEntry, remaining: FeedListEntry[]): FeedEvent['metadata'] {
  const leaving = new Set(entry.bills.map((b) => b.id))
  const had = (Array.isArray(meta.firstBills) ? meta.firstBills : []) as FeedListBill[]
  return {
    ...meta,
    count: Math.max(0, Number(meta.count ?? 0) - 1),
    firstBills: remaining.length >= 2 ? remaining.slice(0, 2).map((e) => e.bills[0]) : had.filter((b) => !leaving.has(b.id)),
  }
}
