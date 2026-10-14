import { Link } from 'react-router-dom'
import { formatMonthYear } from '../lib/calendarDate'
import { chamberLabel } from './LegislativeHistory'
import { color, fontSize } from '../styles/tokens'

/** The bill's pending committee, as the instance API sends it. */
export interface CommitteeRef { committeeId: string | null; name: string; chamber: string | null }
export interface ReferralRef { date: string | null; committeeId: string | null; name: string; chamber: string | null }

const withChamber = (name: string, chamber: string | null) => {
  const label = chamberLabel(chamber ?? undefined)
  return label ? `${name} (${label})` : name
}

/**
 * Where the bill is in committee. A pending committee reads "In committee"; with only
 * referrals it reads "Last referred to", which doesn't claim the bill is still there.
 * Links to the Legislative History section, where the full referral chain is listed.
 */
export function CommitteeLine({ committee, referrals, linkToHistory = true }: {
  committee: CommitteeRef | null
  /** In the provider's order, so the last one is the latest. */
  referrals: ReferralRef[]
  /** False when the page has no Legislative History section to link to. */
  linkToHistory?: boolean
}) {
  const last = referrals[referrals.length - 1]
  if (!committee && !last) return null

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
