import { Fragment, useId, useState } from 'react'
import { CHROME_TEXT } from '../lib/textStyles'
import { TabularRow } from './TabularRow'
import { ExternalLinkIcon } from './ExternalLinkIcon'
import { PartyBadge } from './PartyBadge'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { httpUrl } from '../../../shared/httpUrl'
import { groupVotes, type VoteTone } from '../lib/voteWords'
import { isBillDetailStale, stripDatePrefix, syntheticLatestAction } from '../lib/staleBillDetail'

interface HistoryEntry {
  date: string
  action: string
  chamber?: string
  importance?: number
  /** A recording of the meeting, when the bill's provider publishes one (DC's Council does). */
  videoUrl?: string
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
  /** Each legislator's vote on this roll call, where central has them (any provider). */
  legislatorVotes?: { name: string; vote: string; url?: string | null; party?: string | null }[]
}

interface LegislativeHistoryProps {
  entries: HistoryEntry[]
  votes: VoteEntry[]
  lastAction: string | null
  lastActionDate: string | null
}

type TimelineItem =
  | { kind: 'action'; date: string; chamber?: string; action: string; importance?: number; videoUrl?: string }
  | { kind: 'vote'; date: string; chamber: string | null; desc: string; yea: number; nay: number; nv: number; absent: number; passed: number; legislatorVotes?: { name: string; vote: string; url?: string | null; party?: string | null }[] }

const TONE_COLOR: Record<VoteTone, string> = {
  yea: color.textSuccessDark,
  nay: color.textDanger,
  neutral: color.textSecondary,
}

/** A voter's name: a link to the legislator's profile when central sent an http(s) one, else plain text. */
function VoterName({ name, url }: { name: string; url?: string | null }) {
  const href = httpUrl(url)
  return (
    <span data-testid="voter-name">
      {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="blue-link">{name}<ExternalLinkIcon /></a> : name}
    </span>
  )
}

function VoterNames({ voters }: { voters: { name: string; url?: string | null; party?: string | null }[] }) {
  return <>{voters.map((v, i) => <span key={i}>{i > 0 && ', '}<VoterName name={v.name} url={v.url} />{v.party?.trim() && <PartyBadge party={v.party.trim()} size="mini" />}</span>)}</>
}

/**
 * A roll call's tally: "Yea 11 · Nay 2", plus Not voting and Absent when nonzero.
 * With each legislator's vote it is the toggle for the list (a button with the same
 * ▶ as the Subjects control); without them it is plain text, since nothing would open.
 */
function RollCallTally({ vote }: { vote: Pick<VoteEntry, 'yea' | 'nay' | 'nv' | 'absent' | 'legislatorVotes'> }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const counts: { word: string; n: number; tone: VoteTone }[] = [
    { word: 'Yea', n: vote.yea, tone: 'yea' },
    { word: 'Nay', n: vote.nay, tone: 'nay' },
    ...(vote.nv > 0 ? [{ word: 'Not voting', n: vote.nv, tone: 'neutral' as const }] : []),
    ...(vote.absent > 0 ? [{ word: 'Absent', n: vote.absent, tone: 'neutral' as const }] : []),
  ]
  const items = counts.map((c, i) => (
    <span key={c.word} style={{ display: 'inline-block' }}>
      {i > 0 && <>{' '}<span aria-hidden="true" style={{ color: color.textMuted, margin: '0 3px' }}>·</span>{' '}</>}
      <span style={{ color: TONE_COLOR[c.tone], fontWeight: fontWeight.medium, fontVariantNumeric: 'tabular-nums' }}>{`${c.word} ${c.n}`}</span>
    </span>
  ))
  const groups = vote.legislatorVotes && vote.legislatorVotes.length > 0 ? groupVotes(vote.legislatorVotes) : []
  if (groups.length === 0) return <div style={{ color: color.textSecondary }}>{items}</div>
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(o => !o)}
        style={{
          font: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          borderRadius: radius.xs, color: color.textSecondary,
          display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
        }}
      >
        <span aria-hidden="true" style={{
          fontSize: fontSize.xs, color: color.textMuted, display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s ease',
        }}>▶</span>
        <span>{items}</span>
      </button>
      {open && (
        <dl id={panelId} style={{
          margin: '6px 0 0', display: 'grid', gridTemplateColumns: 'fit-content(40%) 1fr',
          columnGap: 12, rowGap: 4, fontSize: fontSize.xs, color: color.textSecondary,
        }}>
          {groups.map(({ group, voters }) => (
            <Fragment key={group.key}>
              <dt style={{ color: TONE_COLOR[group.tone], fontWeight: fontWeight.bold, minWidth: 0, overflowWrap: 'anywhere' }}>{group.label}</dt>
              <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}><VoterNames voters={voters} /></dd>
            </Fragment>
          ))}
        </dl>
      )}
    </>
  )
}

/** A link to the recording of the meeting an action happened at. Only an http(s) URL becomes a link. */
function MeetingVideo({ url, action }: { url?: string; action: string }) {
  const href = httpUrl(url)
  if (!href) return null
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Video: ${action} (opens in a new tab)`}
      style={{ marginLeft: 8, color: color.linkBlue, fontSize: fontSize.xs, textDecoration: 'none', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 2, verticalAlign: 'middle' }}
    >
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: fontSize.base, lineHeight: 1 }}>play_circle</span>
      Video
    </a>
  )
}

export { syntheticLatestAction }

const isUpper = (c?: string) => c === 'S' || c === 'upper'

export const chamberLabel = (c?: string) =>
  isUpper(c) ? 'Senate'
  : c === 'H' || c === 'lower' ? 'House'
  : c === 'A' ? 'Assembly'
  : c === 'C' ? 'Council'
  : c === 'J' ? 'Joint'
  : c ?? ''

const isCouncil = (c?: string) => c === 'C'

export const chamberStyle = (c?: string): React.CSSProperties => ({
  fontSize: fontSize.xs,
  fontWeight: fontWeight.bold,
  color: isUpper(c) ? color.textTealSenate : isCouncil(c) ? color.textVioletChip : color.textAmberDark,
  background: isUpper(c) ? color.bgTeal : isCouncil(c) ? color.bgVioletChip : color.bgAmberPriority,
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
    ...entries.map((e): TimelineItem => ({ kind: 'action', date: e.date, chamber: e.chamber, action: e.action, importance: e.importance, videoUrl: e.videoUrl })),
    ...votes.map((v): TimelineItem => ({ kind: 'vote', date: v.date, chamber: v.chamber, desc: v.desc, yea: v.yea, nay: v.nay, nv: v.nv, absent: v.absent, passed: v.passed, legislatorVotes: v.legislatorVotes })),
  ].sort((a, b) => b.date.localeCompare(a.date))

  const synthetic = syntheticLatestAction(entries, lastAction, lastActionDate)
  if (synthetic) timeline.unshift({ kind: 'action', date: synthetic.date, action: synthetic.action })
  const showGapNotice = isBillDetailStale(entries, lastAction, lastActionDate)

  const hasTimeline = timeline.length > 1

  return (
    <span>
      {!hideHeader && (
        <button
          type="button"
          aria-expanded={hasTimeline ? open : undefined}
          onClick={() => hasTimeline ? setOpen(s => !s) : undefined}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
          style={{
            fontSize: fontSize.sm,
            color: color.textSlate,
            background: 'none',
            border: 'none',
            borderBottom: 'none',
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
                      {item.passed ? 'Passed' : 'Failed'}
                    </span>
                  )}
                </>
              }
              chip={item.chamber ? <span style={chamberStyle(item.chamber)}>{chamberLabel(item.chamber)}</span> : null}
              content={item.kind === 'action' ? (
                <>
                  <span style={{ color: color.textSlate, fontWeight: item.importance === 1 ? fontWeight.semibold : fontWeight.normal }}>
                    {stripDatePrefix(item.action)}
                  </span>
                  <MeetingVideo url={item.videoUrl} action={stripDatePrefix(item.action)} />
                </>
              ) : (
                <div>
                  <div style={{ color: color.textSlate, fontWeight: fontWeight.medium, marginBottom: 3 }}>{item.desc}</div>
                  <RollCallTally vote={item} />
                </div>
              )}
            />
          </span>))}
        </div>
      )}
    </span>
  )
}
