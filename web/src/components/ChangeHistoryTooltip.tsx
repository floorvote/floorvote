import { CHROME_TEXT } from '../lib/textStyles'
import { color, fontSize, fontWeight } from '../styles/tokens'
import { HoverTooltip } from './HoverTooltip'
import { CHANGE_ICONS } from '../lib/billCardModel'
import { formatBillUpdateDetail } from '../lib/feedUtils'
import { formatMonthDay } from '../lib/calendarDate'
import { feedTsToEpoch } from '../lib/time'

export type ChangeRecord = {
  changeType: string
  oldValue: string | null
  newValue: string | null
  detail: string | null
  detectedAt: string
}

const ICON_PX = 14

// Reuse the shared Feed formatter so a change renders identically here and in
// the feed. The change log additionally surfaces the action's own date inline
// (the shared formatter omits it), because the action date and the detection
// date can differ — and this view is about both.
function changeLogText(c: ChangeRecord): string {
  const base = formatBillUpdateDetail(c)
  if ((c.changeType === 'action_added' || c.changeType === 'hearing_added' || c.changeType === 'hearing_changed' || c.changeType === 'hearing_cancelled') && c.detail) {
    const d = formatMonthDay(c.detail)
    if (d) return `${base} · ${d}`
  }
  return base
}

// Choose the timestamp behind "Updated X ago". The headline must reflect when
// the *bill* last changed — not when the local row was last written (a priority
// change or bulk edit bumps the row's updatedAt without any legislative change).
// So: the most recent detected change wins; failing that, the last legislative
// action date; failing that, nothing (no honest "updated" signal to show).
// Local engagement mutations never write the change log, so they're excluded by
// construction. lastActionDate is date-only ("YYYY-MM-DD") and would NaN through
// dbTsToEpoch ("...Z" with no time), so normalize it to explicit UTC midnight.
export function resolveUpdatedTs(
  changes: ChangeRecord[],
  lastActionDate: string | null | undefined,
): string | null {
  if (changes.length > 0) {
    return changes.reduce(
      (latest, c) => (feedTsToEpoch(c.detectedAt) > feedTsToEpoch(latest) ? c.detectedAt : latest),
      changes[0].detectedAt,
    )
  }
  if (lastActionDate) {
    return /^\d{4}-\d{2}-\d{2}$/.test(lastActionDate) ? `${lastActionDate}T00:00:00Z` : lastActionDate
  }
  return null
}

interface ChangeHistoryTooltipProps {
  changes: ChangeRecord[]
  lastActionDate: string | null
  relativeTime: (date: string) => string
}

export function ChangeHistoryTooltip({ changes, lastActionDate, relativeTime }: ChangeHistoryTooltipProps) {
  const displayTs = resolveUpdatedTs(changes, lastActionDate)
  if (!displayTs) return null

  const trigger = (
    <span style={{
      ...CHROME_TEXT,
      cursor: 'default',
      borderBottom: changes.length > 0 ? `1px dotted ${color.textMuted}` : undefined,
    }}>
      Updated {relativeTime(displayTs)}
    </span>
  )

  if (changes.length === 0) return trigger

  const entries = changes.slice(0, 10)

  const panel = (
    <div>
      <div style={{ fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase' }}>
        Change log
      </div>
      <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginBottom: 6 }}>
        Updates detected by the tracker.
      </div>
      {entries.map((record, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '6px 0',
            borderTop: i > 0 ? `1px solid ${color.surfaceMuted}` : undefined,
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: ICON_PX, color: color.textSecondary, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>
            {CHANGE_ICONS[record.changeType] ?? 'autorenew'}
          </span>
          <span style={{ color: color.textSlate500, flex: 1, minWidth: 0 }}>{changeLogText(record)}</span>
          <span style={{ color: color.textMuted, flexShrink: 0 }}>{formatMonthDay(record.detectedAt)}</span>
        </div>
      ))}
    </div>
  )

  return (
    <HoverTooltip placement="bottom" maxWidth={360} text={panel}>
      {trigger}
    </HoverTooltip>
  )
}
