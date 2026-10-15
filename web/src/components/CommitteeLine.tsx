import { Link } from 'react-router-dom'
import { formatMonthYear } from '../lib/calendarDate'
import { chamberLabel } from './LegislativeHistory'
import { isBillDetailStale } from '../lib/staleBillDetail'
import { color, fontSize } from '../styles/tokens'

/** The bill's pending committee, as the instance API sends it. */
export interface CommitteeRef { committeeId: string | null; name: string; chamber: string | null }
export interface ReferralRef { date: string | null; committeeId: string | null; name: string; chamber: string | null }

const withChamber = (name: string, chamber: string | null) => {
  const label = chamberLabel(chamber ?? undefined)
  return label ? `${name} (${label})` : name
}

/**
 * Where the bill is in committee. Renders nothing when the bill's stored detail is older than
 * its last action: the pending committee and referrals come from that same detail, so neither can
 * be trusted. A pending committee reads "In committee"; with only
 * referrals it reads "Last referred to", which doesn't claim the bill is still there.
 * Links to the Legislative History section, where the full referral chain is listed.
 */
export function CommitteeLine({ committee, referrals, history, lastAction, lastActionDate, linkToHistory = true }: {
  committee: CommitteeRef | null
  /** In the provider's order, so the last one is the latest. */
  referrals: ReferralRef[]
  /** The bill's stored actions and last action, to tell whether the detail above is out of date. */
  history: { date: string; action: string }[]
  lastAction: string | null
  lastActionDate: string | null
  /** False when the page has no Legislative History section to link to. */
  linkToHistory?: boolean
}) {
  const last = referrals[referrals.length - 1]
  if (!committee && !last) return null
  if (isBillDetailStale(history, lastAction, lastActionDate)) return null

  const label = committee ? 'In committee:' : 'Last referred to:'
  const month = !committee && last?.date ? formatMonthYear(last.date) : ''
  const place = committee ? withChamber(committee.name, committee.chamber) : withChamber(last!.name, last!.chamber)

  const text = month ? `${place}, ${month}` : place

  return (
    <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 6 }}>
      <span style={{ color: color.textMuted }}>{label}</span>
      {' '}
      {linkToHistory ? <Link to={{ hash: '#section-actions' }} className="blue-link">{text}</Link> : text}
    </div>
  )
}
