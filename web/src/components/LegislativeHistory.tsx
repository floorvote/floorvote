import { useState } from 'react'
import { CHROME_TEXT } from '../lib/textStyles'
import { TabularRow } from './TabularRow'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'

interface HistoryEntry {
  date: string
  action: string
  chamber?: string
  importance?: number
}

interface VoteEntry {
  date: string
  chamber: string | null
  desc: string
  yea: number
  nay: number
  nv: number
  absent: number
  passed: number
}

interface LegislativeHistoryProps {
  entries: HistoryEntry[]
  votes: VoteEntry[]
  lastAction: string | null
  lastActionDate: string | null
}

type TimelineItem =
  | { kind: 'action'; date: string; chamber?: string; action: string; importance?: number }
  | { kind: 'vote'; date: string; chamber: string | null; desc: string; yea: number; nay: number; nv: number; absent: number; passed: number }

// Strip leading "MM/DD/YYYY " date prefix that some states embed in OpenStates action descriptions
const stripDatePrefix = (s: string) => /^\d{2}\/\d{2}\/\d{4} /.test(s) ? s.slice(11) : s

// Monitoring-only (stub) bills get fresh `lastAction` from the masterlist sync but their
// `history` is only refreshed by getBill, which never runs for stubs — so the timeline can
// lag the headline action. When the last action isn't represented in history, return a
// synthetic entry to prepend so the unfolded timeline never omits the action shown elsewhere.
export function syntheticLatestAction(
  entries: HistoryEntry[],
  lastAction: string | null,
  lastActionDate: string | null,
): { date: string; action: string } | null {
  if (!lastAction || !lastActionDate) return null
  const action = stripDatePrefix(lastAction)
  const represented = entries.some(e => e.date === lastActionDate && stripDatePrefix(e.action) === action)
  if (represented) return null
  const newestEntryDate = entries.reduce((max, e) => (e.date > max ? e.date : max), '')
  if (lastActionDate < newestEntryDate) return null
  return { date: lastActionDate, action }
}

const isUpper = (c?: string) => c === 'S' || c === 'upper'

export const chamberLabel = (c?: string) =>
  isUpper(c) ? 'Senate'
  : c === 'H' || c === 'lower' ? 'House'
  : c === 'A' ? 'Assembly'
  : c ?? ''

export const chamberStyle = (c?: string): React.CSSProperties => ({
  fontSize: fontSize.xs,
  fontWeight: fontWeight.bold,
  color: isUpper(c) ? color.textTealSenate : color.textAmberDark,
  background: isUpper(c) ? color.bgTeal : color.bgAmberPriority,
  padding: '1px 5px',
  borderRadius: radius.sm,
  alignSelf: 'flex-start',
  whiteSpace: 'nowrap',
  flexShrink: 0,
})

export function LegislativeHistory({ entries, votes, lastAction, lastActionDate, defaultOpen, hideHeader }: LegislativeHistoryProps & { defaultOpen?: boolean; hideHeader?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)

  if (!lastAction) return null

  // Merge history actions and votes into one sorted timeline
  const timeline: TimelineItem[] = [
    ...entries.map((e): TimelineItem => ({ kind: 'action', date: e.date, chamber: e.chamber, action: e.action, importance: e.importance })),
    ...votes.map((v): TimelineItem => ({ kind: 'vote', date: v.date, chamber: v.chamber, desc: v.desc, yea: v.yea, nay: v.nay, nv: v.nv, absent: v.absent, passed: v.passed })),
  ].sort((a, b) => b.date.localeCompare(a.date))

  const synthetic = syntheticLatestAction(entries, lastAction, lastActionDate)
  if (synthetic) timeline.unshift({ kind: 'action', date: synthetic.date, action: synthetic.action })
  // Only flag a gap when there are real history entries to gap against
  const showGapNotice = !!synthetic && entries.length > 0

  const hasTimeline = timeline.length > 1

  return (
    <span>
      {!hideHeader && (
        <button
          onClick={() => hasTimeline ? setOpen(s => !s) : undefined}
          style={{
            fontSize: fontSize.sm,
            color: color.textSlate,
            background: 'none',
            border: 'none',
            borderBottom: hasTimeline ? `1px dotted ${color.textMuted}` : 'none',
            cursor: hasTimeline ? 'pointer' : 'default',
            padding: 0,
          }}
        >
          {stripDatePrefix(lastAction)}
          {lastActionDate && <span style={{ color: color.textMuted, marginLeft: 4 }}>{lastActionDate}</span>}
          {hasTimeline && <span style={{ ...CHROME_TEXT, marginLeft: 4 }}>{open ? '▲' : `▼ ${timeline.length} event${timeline.length === 1 ? '' : 's'}`}</span>}
        </button>
      )}
      {(open || hideHeader) && (
        <div style={{ marginTop: 8 }}>
          {timeline.map((item, i) => (<span key={i}>
            {showGapNotice && i === 1 && (
              <div
                title="This bill is monitored at a summary level — the latest action is current, but intermediate steps are fetched only for tracked bills."
                style={{
                  textAlign: 'center',
                  color: color.textMuted,
                  fontSize: fontSize.xs,
                  fontStyle: 'italic',
                  padding: '5px 0',
                  borderTop: `1px dotted ${color.borderStrong}`,
                }}
              >
                some actions between these dates may not be shown
              </div>
            )}
            <TabularRow
              showTopBorder={i > 0 && !(showGapNotice && i === 1)}
              borderLeftColor={item.kind === 'vote' ? (item.passed ? color.textSuccess : color.textDanger) : undefined}
              opacity={item.kind === 'action' && item.importance === 0 ? 0.65 : 1}
              date={
                <>
                  <span style={{ whiteSpace: 'nowrap' }}>{item.date}</span>
                  {item.kind === 'vote' && (
                    <span style={{
                      fontSize: fontSize.xs, fontWeight: fontWeight.bold,
                      color: item.passed ? color.textSuccessDark : color.textDanger,
                      background: item.passed ? color.bgSuccessChip : color.bgRedPriority,
                      padding: '1px 5px', borderRadius: radius.sm, whiteSpace: 'nowrap',
                      alignSelf: 'flex-start',
                    }}>
                      {item.passed ? 'VOTE: PASSED' : 'VOTE: FAILED'}
                    </span>
                  )}
                </>
              }
              chip={item.chamber ? <span style={chamberStyle(item.chamber)}>{chamberLabel(item.chamber)}</span> : null}
              content={item.kind === 'action' ? (
                <span style={{ color: color.textSlate, fontWeight: item.importance === 1 ? fontWeight.semibold : fontWeight.normal }}>
                  {stripDatePrefix(item.action)}
                </span>
              ) : (
                <div>
                  <div style={{ color: color.textSlate, fontWeight: fontWeight.medium, marginBottom: 3 }}>{item.desc}</div>
                  <div style={{ display: 'flex', gap: 10, color: color.textSecondary, flexWrap: 'wrap' }}>
                    <span>Yea: <strong style={{ color: color.textSuccess }}>{item.yea}</strong></span>
                    <span>Nay: <strong style={{ color: color.textDanger }}>{item.nay}</strong></span>
                    {item.nv > 0 && <span>NV: {item.nv}</span>}
                    {item.absent > 0 && <span>Absent: {item.absent}</span>}
                  </div>
                </div>
              )}
            />
          </span>))}
        </div>
      )}
    </span>
  )
}
