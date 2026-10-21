import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { FeedEvent, GroupedBillEvents } from '../lib/feedUtils'
import { billCardRowText, buildBillCardModel, CARD_STYLE } from '../lib/billCardModel'
import { billUrl } from '../lib/sessionSlug'
import { billDisplayTitle } from '../../../shared/billTitle'
import { BILL_TITLE_TEXT } from '../lib/textStyles'
import { color, fontSize } from '../styles/tokens'
import { BillBadge } from './BillBadge'
import { DraftChip } from './DraftChip'
import { PrioritySquare } from './PrioritySquare'
import { ResizeHandle, useVerticalResize } from './ResizeHandle'

/** A bill as an entry of a feed row's expanded list shows it: a chip with its hover card, and its title. */
export type FeedListBill = {
  id: string; billNumber: string; title: string; state: string | null; sessionSlug: string | null; isDraft: boolean
  /** The bill's companion group, or null. */
  groupKey?: string | null
  /** For the chip's hover card. Null or absent: the card fetches it. */
  summary?: string | null
  /** The priority the bill wears (its group's, in a group), for the chip's hover card. Null or absent: none. */
  priority?: 'high' | 'medium' | 'low' | null
}

/** One of an entry's events that day, which the entry draws as a card's row draws it. */
export type FeedListEvent = { id: string; type: FeedEvent['type']; billId: string; metadata: Record<string, unknown>; createdAt: string }

/**
 * One entry of the list: a bill, or the bills of one companion group (a group is
 * one policy, so one entry), the first of them the one its title names. With
 * `events`, the entry lists its changes that day under the title.
 */
export type FeedListEntry = { key: string; bills: FeedListBill[]; events?: FeedListEvent[] }

export type FeedListPage = { entries: FeedListEntry[]; hasMore: boolean }

type Status = 'loading' | 'idle' | 'error'

// How close to the end of the box a scroll has to come to load the next page.
const NEAR_END_PX = 120

/**
 * The expanded list of a bill-less feed row that names many bills (the
 * no-priority updates row, and the new-matches row in time): loaded a page at a
 * time, first when it mounts and then as the reader scrolls to the end of its
 * box. The box is a card's scroll box, 300px with the drag handle that resizes it.
 * A failed page shows the feed's retry note and keeps the entries it has.
 */
export function FeedBillList({ loadPage, emptyNote = 'These bills are no longer available.' }: {
  loadPage: (page: number) => Promise<FeedListPage>
  emptyNote?: string
}) {
  const [entries, setEntries] = useState<FeedListEntry[]>([])
  const [status, setStatus] = useState<Status>('loading')
  const [hasMore, setHasMore] = useState(true)
  const nextPage = useRef(1)
  const busy = useRef(false)
  const { height, hasResized, handlePointerDown } = useVerticalResize(300, 60)
  const boxRef = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)

  const load = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setStatus('loading')
    try {
      const page = await loadPage(nextPage.current)
      nextPage.current += 1
      // A bill that left the list between two pages shifts the next one back by
      // an entry, so a page can repeat the last one: list each entry once.
      setEntries((had) => {
        const seen = new Set(had.map((e) => e.key))
        return [...had, ...page.entries.filter((e) => !seen.has(e.key))]
      })
      setHasMore(page.hasMore)
      setStatus('idle')
    } catch {
      setStatus('error')
    } finally {
      busy.current = false
    }
  }, [loadPage])

  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = boxRef.current
    if (el) setOverflows(el.scrollHeight > el.clientHeight)
  }, [height, entries.length])

  function onScroll() {
    const el = boxRef.current
    if (!el || !hasMore || status !== 'idle') return
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_END_PX) void load()
  }

  return (
    <>
      <div data-feed-bill-list ref={boxRef} onScroll={onScroll} style={{ maxHeight: height, overflowY: 'auto' }}>
        {entries.map((entry, i) => <Entry key={entry.key} entry={entry} first={i === 0} />)}
        {status === 'loading' && <Note>Loading…</Note>}
        {status === 'error' && (
          <Note>
            Couldn’t load the bills.{' '}
            <button type="button" onClick={() => void load()} style={{ all: 'unset', cursor: 'pointer', color: color.linkBlue, textDecoration: 'underline' }}>
              Try again
            </button>
          </Note>
        )}
        {status === 'idle' && entries.length === 0 && <Note>{emptyNote}</Note>}
      </div>
      {entries.length > 0 && (overflows || hasMore || hasResized) && <ResizeHandle onPointerDown={handlePointerDown} />}
    </>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '10px 14px', fontSize: fontSize.sm, color: color.textMuted }}>{children}</div>
}

function MaterialIcon({ name, color: c, fill = 0, size = 14 }: { name: string; color: string; fill?: 0 | 1; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="material-symbols-outlined"
      style={{
        fontSize: size, color: c, display: 'inline', verticalAlign: 'middle', flexShrink: 0, lineHeight: 1.4,
        fontVariationSettings: `'FILL' ${fill}, 'wght' 400, 'GRAD' 0, 'opsz' 24`,
      }}
    >
      {name}
    </span>
  )
}

const pathOf = (b: FeedListBill) => billUrl({ id: b.id, state: b.state, sessionSlug: b.sessionSlug, billNumber: b.billNumber })

/**
 * The chip a feed row shows for a bill: mini, linking to its page, with the
 * sidebar's hover card. `draftSrLabel` names a draft's chip as a draft for a
 * screen reader, where no visible Draft chip sits beside it (BillBadge).
 */
export function FeedBillChip({ bill, draftSrLabel }: { bill: FeedListBill; draftSrLabel?: boolean }) {
  return (
    <BillBadge
      billNumber={bill.billNumber} state={bill.state} isDraft={bill.isDraft} mini to={pathOf(bill)} draftSrLabel={draftSrLabel}
      hoverBill={{ billId: bill.id, title: bill.title, isDraft: bill.isDraft, summary: bill.summary ?? null, priority: bill.priority ?? null }}
    />
  )
}

// The entry's events as a card for its bills, so its rows are a card's rows:
// the same text and icons, labeled with their bill in a companion group's.
function asCard(entry: FeedListEntry): GroupedBillEvents {
  const lead = entry.bills[0]
  const byId = new Map(entry.bills.map((b) => [b.id, b]))
  const groupKey = lead.groupKey ?? null
  const events: FeedEvent[] = (entry.events ?? []).map((e) => {
    const b = byId.get(e.billId) ?? lead
    return {
      ...e, billNumber: b.billNumber, billSessionSlug: b.sessionSlug, billState: b.state, billTitle: b.title,
      billSummary: b.summary ?? null, billPriority: null, billMatchType: null, billIsDraft: b.isDraft, billGroupKey: b.groupKey ?? null,
      userId: 'system', userName: '', userTitle: null,
    }
  })
  return {
    key: entry.key, billId: lead.id, billNumber: lead.billNumber, billTitle: lead.title, billSessionSlug: lead.sessionSlug,
    billState: lead.state, billSummary: lead.summary ?? null, billPriority: null, billMatchType: null, billIsDraft: lead.isDraft,
    groupKey, date: '', events,
    ...(groupKey !== null ? { bills: entry.bills.map((b) => ({ billId: b.id, billNumber: b.billNumber, billState: b.state, billSessionSlug: b.sessionSlug, billIsDraft: b.isDraft })) } : {}),
  }
}

function Entry({ entry, first }: { entry: FeedListEntry; first: boolean }) {
  const lead = entry.bills[0]
  const rows = entry.events?.length ? buildBillCardModel(asCard(entry)).rows : []
  return (
    <div data-bill-entry style={{ padding: '8px 14px', borderTop: first ? 'none' : `1px solid ${CARD_STYLE.rowBorder}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {/* Each draft member with its own Draft chip, as a companion group's card shows them. */}
        {entry.bills.map((b) => (
          <span key={b.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FeedBillChip bill={b} />
            {b.isDraft && <DraftChip />}
          </span>
        ))}
        <Link
          to={pathOf(lead)}
          style={{
            ...BILL_TITLE_TEXT, fontSize: fontSize.sm, color: color.textPrimary, textDecoration: 'none',
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {billDisplayTitle({ title: lead.title, isDraft: lead.isDraft })}
        </Link>
      </div>
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 3 }}>
          {row.square ? (
            <PrioritySquare size={11} color={row.iconColor} hollow={row.hollow} style={{ marginTop: 3 }} />
          ) : (
            <MaterialIcon name={row.iconName} color={row.iconColor} fill={row.iconFill} />
          )}
          <span style={{ fontSize: fontSize.sm, color: color.textSlate500, lineHeight: 1.4, minWidth: 0 }}>{billCardRowText(row)}</span>
        </div>
      ))}
    </div>
  )
}
