import { Link } from 'react-router-dom'
import { HoverTooltip } from '../../components/HoverTooltip'
import { CHROME_TEXT } from '../../lib/textStyles'
import { color } from '../../styles/tokens'
import type { ListSummary } from './listSummary'

// The hover list shows this many filters, then says how many more. The bubble
// is position:fixed and takes no scroll, so an unbounded list would run off the
// bottom of the window; the Bills page, one click away, has the rest.
const MAX_LISTED = 15

/**
 * The line under the split pane's "Bills" header: what the list is filtered by
 * and how it is sorted, with a link back to the Bills page to change either.
 * Read-only by design — the pane never edits or clears a filter.
 *
 * With filters, the text is a HoverTooltip term: a button (so a tab stop) that
 * previews the filter list on hover and focus, pins it on click, closes on
 * Escape, and points a screen reader at a hidden copy of the list.
 */
export function BillListPaneSummary({ summary, listUrl }: { summary: ListSummary; listUrl: string }) {
  const { filters } = summary
  const shown = filters.slice(0, MAX_LISTED)
  const list = filters.length === 0 ? null : (
    <>
      {shown.map((label, i) => <span key={i} data-filter style={{ display: 'block' }}>{label}</span>)}
      {filters.length > shown.length && <span style={{ display: 'block' }}>and {filters.length - shown.length} more</span>}
    </>
  )
  return (
    <div data-pane-summary style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, padding: '0 12px 10px 15px' }}>
      <span style={{ ...CHROME_TEXT, flex: '1 1 auto', minWidth: 0 }}>
        <HoverTooltip text={list} describe placement="bottom" maxWidth={260}>
          <span style={{ overflowWrap: 'anywhere' }}>{summary.text}</span>
        </HoverTooltip>
      </span>
      <Link to={listUrl} style={{ ...CHROME_TEXT, color: color.linkBlue, textDecoration: 'none', flexShrink: 0, whiteSpace: 'nowrap' }}>Edit</Link>
    </div>
  )
}
