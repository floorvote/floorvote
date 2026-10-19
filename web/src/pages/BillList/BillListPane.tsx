import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation, useMatch } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { decodeStatus } from '../../lib/legislativeStatus'
import { billUrl } from '../../lib/sessionSlug'
import { normalizeViewQuery, matchesUrlIdentifier } from '../../lib/savedViews'
import { useMultiState } from '../../context/ConfigContext'
import { BillBadge } from '../../components/BillBadge'
import { DraftChip } from '../../components/DraftChip'
import { StatusChip } from '../../components/StatusChip'
import { SessionChip } from '../../components/SessionChip'
import { RelevanceChip } from '../../components/RelevanceChip'
import { LastActionChip } from '../../components/LastActionChip'
import { SECTION_LABEL, CHROME_TEXT, SR_ONLY, BILL_TITLE_TEXT } from '../../lib/textStyles'
import { color, fontSize, fontWeight } from '../../styles/tokens'
import { billDisplayTitle } from '../../../../shared/billTitle'
import { billsApiParamsFromSearch, billsQueryFromSearch, searchFromListUrl } from './billsQuery'
import { buildListSummary } from './listSummary'
import { BillListPaneSummary } from './BillListPaneSummary'
import { peekBillsListCache, peekCustomFieldDefs } from './index'
import { groupDisplay, memberPath, formatYearChip } from './BillRow'
import { groupPlacement, groupGridStyle, groupItemStyle, subgridCellStyle, GROUP_ROW_GAP } from './groupRows'
import { PANE_MIN_WIDTH, paneGridTemplate, visiblePaneColumns, type PaneColumn } from './paneWidth'
import { PaneResizeHandle, useBillListPaneWidth } from './BillListPaneResize'
import type { Bill } from './types'
import type { SavedView } from './ViewSwitcher'

// Viewport width at which a bill page shows this pane beside it. At 1440 with
// the default 230px sidebar and this 300px pane, BillDetail still gets about
// 900px — what it gets today in a ~1150px window, wide enough that its
// 272px right column and its main column sit side by side as they do now.
// The reader can drag it wider (paneWidth.ts holds the bounds); 300px is the
// width it starts at and the narrowest it goes.
export const BILL_SPLIT_MIN_WIDTH = 1440

type BillsPage = { bills: Bill[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }

// The Bills page records its own URL in sessionStorage on every change (the
// sidebar's Bills link and BillDetail's "Back to bills" both read it), so the
// pane shows that same list. A saved view leaves the URL in its short
// `?view=<slug>` form, which spells out no filters, so it is expanded from
// /views here the way BillList hydrates it. The view comes back too, for the
// summary line to name; a slug that matches nothing returns the bare search.
type ResolvedList = { search: URLSearchParams; view: SavedView | null }

async function resolveListSearch(listUrl: string): Promise<ResolvedList> {
  const search = searchFromListUrl(listUrl)
  const viewId = search.get('view')
  if (!viewId || normalizeViewQuery(search.toString()) !== '') return { search, view: null }
  try {
    const { views } = await apiFetch<{ views: SavedView[] }>('/views')
    const view = (views ?? []).find(v => matchesUrlIdentifier(v, viewId))
    if (view) return { search: new URLSearchParams(view.query), view }
  } catch {
    // Fall through to the unfiltered list rather than showing nothing.
  }
  return { search, view: null }
}

// location.pathname arrives percent-encoded ("HB%205042") while billUrl builds
// the raw form ("HB 5042"), so compare decoded.
function decodePath(path: string): string {
  try { return decodeURI(path) } catch { return path }
}

// A bill is the open one when it is the row's own bill or, for a group row,
// any bill in the group: the row's own fields are the lead's, so opening a
// companion would otherwise highlight nothing. `legacyId` is the id on a
// /bills/:billId URL, whose path is never the canonical one the row builds.
function isOpenBill(bill: Bill, path: string, here: string, legacyId: string | undefined): boolean {
  if (path === here || (legacyId !== undefined && bill.id === legacyId)) return true
  return !!bill.group?.some(m => memberPath(m) === here || (legacyId !== undefined && m.id === legacyId))
}

// A narrow pane has no status column: a group's numbers and statuses are the
// two columns of one grid, a status on its bill's row, the statuses at the
// row's right edge (see groupRows.ts).
const PAIRS: CSSProperties = { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 8, rowGap: GROUP_ROW_GAP, alignItems: 'center', width: '100%' }

// The header the columns sit under: sticky at the top of the scrolling list, on
// the same grid as every row so each header is over its cells.
const COLUMN_HEADER_HEIGHT = 30

function PaneColumnHeaders({ columns, multiState }: { columns: PaneColumn[]; multiState: boolean }) {
  return (
    <li
      data-pane-columns
      style={{
        position: 'sticky', top: 0, zIndex: 1, height: COLUMN_HEADER_HEIGHT, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', padding: '0 12px 0 15px',
        background: color.surfaceSubtle, borderBottom: `1px solid ${color.borderDefault}`,
      }}
    >
      <div data-pane-grid style={{ display: 'grid', gridTemplateColumns: paneGridTemplate(columns, multiState), columnGap: 8, alignItems: 'center', width: '100%' }}>
        <span />
        {columns.map(c => (
          <span key={c.key} data-pane-col-header={c.key} style={{ ...SECTION_LABEL, whiteSpace: 'nowrap' }}>{c.label}</span>
        ))}
      </div>
    </li>
  )
}

const PaneRow = memo(function PaneRow({ bill, path, isCurrent, billPaths, index, columns, multiState }: {
  bill: Bill; path: string; isCurrent: boolean; billPaths: string[]; index: number
  columns: PaneColumn[]; multiState: boolean
}) {
  const [hovered, setHovered] = useState(false)
  // A companion group is one row (the lead's), drawn as the Bills list draws it:
  // the lead and one other number, "+N" for the rest, each shown status once.
  const group = bill.group ? groupDisplay(bill.group) : null
  const companions = bill.group ? bill.group.slice(1) : []
  const wide = columns.length > 0

  const placement = group ? groupPlacement(group) : null
  // The priority is the group's, so every one of its numbers carries the square.
  // Where the pieces go: groupRows.ts. `column` is given only for the narrow pane's
  // two-column grid, where a number or status has no cell of its own.
  const groupNumbers = (column?: number) => group && placement && [
    ...group.shown.map((m, i) => (
      <div key={m.id} data-group-item="number" style={groupItemStyle(placement.numberRows[i], column)}>
        <BillBadge mini billNumber={m.billNumber} state={m.state} priority={bill.priority} />
      </div>
    )),
    ...(placement.moreRow !== null ? [(
      <div key="more" data-group-item="more" style={groupItemStyle(placement.moreRow, column)}>
        <span aria-hidden style={{ ...CHROME_TEXT, fontWeight: fontWeight.semibold }}>+{group.hidden.length}</span>
      </div>
    )] : []),
  ]
  const groupStatuses = (column?: number, atEnd = false) => group && placement && group.statuses.map((status, i) => (
    <div key={status} data-group-item="status" style={{ ...groupItemStyle(placement.statusRows[i], column), ...(atEnd ? { justifySelf: 'end' } : {}) }}>
      <StatusChip capWidth status={decodeStatus(status)} />
    </div>
  ))
  const numbers = <BillBadge mini billNumber={bill.billNumber} state={bill.state} isDraft={bill.isDraft} priority={bill.priority} />
  const priorityForReaders = bill.priority && <span style={SR_ONLY}>, {bill.priority} priority</span>

  // What each column holds: the Bills page's own chips, drawn read-only (the
  // row is a link, and the pane filters nothing).
  const cells: Record<PaneColumn['key'], ReactNode> = {
    status: group ? groupStatuses() : bill.isDraft ? <DraftChip /> : <StatusChip capWidth status={decodeStatus(bill.status)} />,
    year: <SessionChip session={formatYearChip(bill.yearStart, bill.yearEnd)} />,
    lastAction: <LastActionChip date={bill.lastActionDate} />,
    relevance: <RelevanceChip score={bill.relevanceScore} />,
  }

  return (
    <Link
      to={path}
      // Same prev/next context a click on the Bills page passes, so
      // BillDetail's previous/next controls walk this list.
      state={{ billPaths, currentIndex: index }}
      aria-current={isCurrent ? 'page' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        // 15px, not 12: the open row used to mark itself with a 3px left border
        // (transparent on the others), and that room is now padding so the text
        // stays where it was. The blue background alone marks the open row.
        padding: '8px 12px 9px 15px',
        borderBottom: `1px solid ${color.borderDefault}`,
        background: isCurrent ? color.bgBlueChip : hovered ? color.surfaceSubtle : color.white,
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      {wide ? (
        // Wide: the status moves into its column, so it is not also drawn at
        // the row's top right. A group's number and status cells are subgrids
        // of a grid with a row per bill, so each status is level with its bill.
        <div
          data-pane-grid
          data-group-rows={placement?.rows}
          style={{
            display: 'grid', gridTemplateColumns: paneGridTemplate(columns, multiState), columnGap: 8,
            alignItems: group ? 'start' : 'center', marginBottom: 4,
            ...(placement ? groupGridStyle(placement.rows) : {}),
          }}
        >
          {group
            ? <div style={subgridCellStyle}>{groupNumbers()}{priorityForReaders}</div>
            : <div>{numbers}{priorityForReaders}</div>}
          {columns.map(c => (
            <div
              key={c.key}
              data-pane-col={c.key}
              style={{
                display: 'flex', alignItems: 'center', minWidth: 0,
                // The status column of a group is a subgrid; the other columns span every row.
                ...(group ? (c.key === 'status' ? subgridCellStyle : { gridRow: '1 / -1' }) : {}),
              }}
            >{cells[c.key]}</div>
          ))}
        </div>
      ) : group && placement ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 4 }}>
          <div data-group-pairs style={PAIRS}>
            {groupNumbers(1)}
            {groupStatuses(2, true)}
            {priorityForReaders}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          {numbers}
          {priorityForReaders}
          <span style={{ marginLeft: 'auto', display: 'flex', minWidth: 0 }}>
            {bill.isDraft ? <DraftChip mini /> : <StatusChip capWidth status={decodeStatus(bill.status)} />}
          </span>
        </div>
      )}
      <div style={{
        ...BILL_TITLE_TEXT,
        fontSize: fontSize.sm,
        color: color.textPrimary,
        lineHeight: 1.35,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {billDisplayTitle(bill)}
      </div>
      {/* Only the lead and one other number are drawn, so a screen reader is
          told of every companion by number. */}
      {companions.length > 0 && (
        <span style={SR_ONLY}>, with {companions.length} companion {companions.length === 1 ? 'bill' : 'bills'}: {companions.map(m => m.billNumber).join(', ')}</span>
      )}
    </Link>
  )
})

/**
 * The Bills list, compact, beside a bill on wide screens. AppLayout mounts it
 * once for every bill route, so it keeps its scroll position as the reader
 * moves from bill to bill.
 */
export function BillListPane() {
  const location = useLocation()
  const [listUrl] = useState(() => sessionStorage.getItem('lastBillsUrl') ?? '/bills')
  const multiState = useMultiState()
  const [resolved, setResolved] = useState<ResolvedList | null>(null)
  const search = resolved?.search ?? null
  const [bills, setBills] = useState<Bill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const scrollRef = useRef<HTMLUListElement>(null)
  const pane = useBillListPaneWidth()
  const columns = visiblePaneColumns(pane.width)

  useEffect(() => {
    let cancelled = false
    void resolveListSearch(listUrl).then(r => { if (!cancelled) setResolved(r) })
    return () => { cancelled = true }
  }, [listUrl])

  useEffect(() => {
    if (!search) return
    let cancelled = false
    const params = billsApiParamsFromSearch(search, 1, peekCustomFieldDefs())
    // The Bills page's first-page cache paints instantly when it holds this
    // same query; the fetch below then refreshes it.
    const cached = peekBillsListCache()
    if (cached?.params === params) {
      setBills(cached.page.bills)
      setTotal(cached.page.total)
      setHasMore(cached.page.totalPages > 1)
      setLoading(false)
    }
    apiFetch<BillsPage>(`/bills?${params}`)
      .then(data => {
        if (cancelled) return
        setBills(data.bills)
        setTotal(data.pagination.total)
        setHasMore(data.pagination.totalPages > 1)
        setPage(1)
        setError(false)
      })
      .catch(() => { if (!cancelled && !cached) setError(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [search])

  const [loadingMore, setLoadingMore] = useState(false)
  function loadMore() {
    if (!search || loadingMore) return
    setLoadingMore(true)
    const next = page + 1
    apiFetch<BillsPage>(`/bills?${billsApiParamsFromSearch(search, next, peekCustomFieldDefs())}`)
      .then(data => {
        setBills(prev => [...prev, ...data.bills])
        setHasMore(next < data.pagination.totalPages)
        setPage(next)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }

  const here = decodePath(location.pathname)
  const legacyId = useMatch('/bills/:billId')?.params.billId
  const paths = useMemo(() => bills.map(b => billUrl({ id: b.id, state: b.state, sessionSlug: b.sessionSlug, billNumber: b.billNumber })), [bills])

  // The summary is of the list the pane shows: the same resolved query its
  // request is built from, so the line and the rows cannot disagree.
  const summary = useMemo(() => resolved && buildListSummary({
    values: billsQueryFromSearch(resolved.search),
    view: resolved.view,
    customFieldDefs: peekCustomFieldDefs(),
    isMultiState: multiState,
  }), [resolved, multiState])

  // Bring the current bill into view only when it is off-screen, and only when
  // the bill changes (or the list first arrives) — never when "Show more"
  // appends, which would yank the reader back from where they scrolled.
  // `loading` is a dependency because the list renders only once it is false:
  // were the bills and the end of loading ever committed separately, an effect
  // that ran in between would find no list and never run again.
  const hasBills = bills.length > 0
  useLayoutEffect(() => {
    const row = scrollRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    // 'nearest' moves nothing when the row is already on screen. The pane only
    // exists on wide viewports, where the document itself never scrolls.
    row?.scrollIntoView({ block: 'nearest' })
  }, [location.pathname, hasBills, loading])

  return (
    <nav
      aria-label="Bill list"
      className="bill-list-pane"
      style={{
        position: 'relative',
        width: pane.width,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: color.white,
        borderRight: `1px solid ${color.borderDefault}`,
      }}
    >
      <div style={{ borderBottom: `1px solid ${color.borderDefault}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '14px 12px 10px 15px' }}>
          <Link to={listUrl} style={{ ...SECTION_LABEL, color: color.linkBlue, textDecoration: 'none' }}>Bills</Link>
          {!loading && !error && <span style={CHROME_TEXT}>{total.toLocaleString()} {total === 1 ? 'bill' : 'bills'}</span>}
        </div>
        {!loading && !error && summary && <BillListPaneSummary summary={summary} listUrl={listUrl} />}
      </div>
      {loading ? (
        <p style={{ ...CHROME_TEXT, padding: '12px 15px', margin: 0 }}>Loading bills…</p>
      ) : error ? (
        <p style={{ ...CHROME_TEXT, padding: '12px 15px', margin: 0 }}>Couldn’t load bills.</p>
      ) : bills.length === 0 ? (
        <p style={{ ...CHROME_TEXT, padding: '12px 15px', margin: 0 }}>No bills match this list’s filters.</p>
      ) : (
        <ul
          ref={scrollRef}
          style={{
            listStyle: 'none', margin: 0, padding: 0, flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative',
            // Keeps scrollIntoView from parking the open row under the sticky headers.
            scrollPaddingTop: columns.length > 0 ? COLUMN_HEADER_HEIGHT : undefined,
          }}
        >
          {columns.length > 0 && <PaneColumnHeaders columns={columns} multiState={multiState} />}
          {bills.map((b, i) => (
            <li key={b.id}>
              <PaneRow bill={b} path={paths[i]} isCurrent={isOpenBill(b, paths[i], here, legacyId)} billPaths={paths} index={i} columns={columns} multiState={multiState} />
            </li>
          ))}
          {hasMore && (
            <li style={{ padding: 12 }}>
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                style={{ width: '100%', padding: '6px 10px', fontSize: fontSize.sm, color: color.linkBlue, background: color.white, border: `1px solid ${color.borderDefault}`, cursor: 'pointer' }}
              >
                {loadingMore ? 'Loading…' : `Show more (${bills.length.toLocaleString()} of ${total.toLocaleString()})`}
              </button>
            </li>
          )}
        </ul>
      )}
      {pane.max > PANE_MIN_WIDTH && <PaneResizeHandle width={pane.width} max={pane.max} pane={pane} />}
    </nav>
  )
}
