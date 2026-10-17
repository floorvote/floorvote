import { color, fontSize, fontWeight } from './tokens'
import { PRIORITY_COLORS, POSITION_FEED_ICON } from './billChipColors'
import { COMMENT_PREVIEW_MAX, formatBillUpdateDetail, stripHtml, type ChangeRecord, type FeedEvent, type GroupedBill, type GroupedBillEvents } from './feedUtils'
import { formatHearingTime } from './hearingTime'
import { stripMarkdown } from './markdown'
import { billDisplayTitle } from './billTitle'

const SUMMARY_BG = color.surfaceSubtle

// Exported so the email-icon generator can enumerate which (glyph, color) PNGs
// to render — keeps the email row icons in lockstep with the Feed.
export const CHANGE_ICONS: Record<string, string> = {
  status_change: 'flag', action_added: 'arrow_forward', text_added: 'description',
  amendment_added: 'edit_note', supplement_added: 'attach_file',
  sponsor_added: 'person_add', sponsor_removed: 'person_remove',
  vote_added: 'how_to_vote', title_changed: 'edit', description_changed: 'edit',
  hearing_added: 'event', hearing_changed: 'event', hearing_cancelled: 'event',
}
export const USER_EVENT_ICONS: Record<string, { name: string; color: string; fill?: 0 | 1 }> = {
  bill_added:     { name: 'playlist_add',   color: color.accentBlue },
  priority_set:   { name: 'flag',           color: color.textDanger, fill: 1 },
  position_set:   { name: 'thumbs_up_down', color: color.textSuccess, fill: 1 },
  comment_added:  { name: 'chat',           color: color.brandViolet },
  vote_milestone: { name: 'how_to_vote',    color: color.textTealSenate },
}
const HEARING_TYPES = new Set(['hearing_added', 'hearing_changed', 'hearing_cancelled'])

export type BillCardRow = {
  key: string; iconName: string; iconColor: string; iconFill: 0 | 1
  text: string; bg: string; hash: string; createdAt: string; showTime: boolean
  userId: string
  /** When true, render a priority square instead of a glyph (priority_set events). */
  square?: boolean
  /** The bill the row's event is on, so a row in a companion group's card opens its own bill. */
  billId: string | null
  /**
   * The number of the bill the row's event is on, shown in front of the text, in
   * a companion group's card: the card stands for the group, so each row says
   * which of its bills it happened on. Null in a bill's own card.
   */
  billLabel: string | null
}
export type BillCardModel = {
  billNumber: string; state: string | null; sessionSlug: string | null
  title: string; summary: string | null; priority: 'high' | 'medium' | 'low' | null
  rows: BillCardRow[]
  /** A companion group's card: the bills with events in it, for the header. Absent in a bill's own card. */
  bills?: GroupedBill[]
}

/** A row's text as it reads in a card: in front of it, the number of its bill when the card is a companion group's. */
export function billCardRowText(row: Pick<BillCardRow, 'text' | 'billLabel'>): string {
  return row.billLabel ? `${row.billLabel}: ${row.text}` : row.text
}
export const CARD_STYLE = {
  headerBg: color.surfaceSubtle, border: color.borderDefault,
  badgeBg: color.billBadgeNavy, badgeColor: color.textOnFill,
  titleFontFamily: "'Source Serif 4', Georgia, serif", titleSize: fontSize.base,
  titleWeight: fontWeight.bold, titleColor: color.textPrimary,
  summaryFontFamily: "'Source Serif 4', Georgia, serif", summarySize: fontSize.sm,
  summaryColor: color.textSecondary, rowText: color.textSlate500, rowSize: fontSize.sm,
  rowBorder: color.borderDefault,
  shadow: '0 1px 3px rgba(0,0,0,0.04)', shadowHover: '0 2px 8px rgba(0,0,0,0.08)',
} as const

function getBillUpdateChanges(event: FeedEvent): ChangeRecord[] {
  const raw = (event.metadata as Record<string, unknown>)?.changes
  return Array.isArray(raw) ? (raw as ChangeRecord[]) : []
}
function changeRowHash(change: ChangeRecord): string {
  switch (change.changeType) {
    case 'action_added': case 'vote_added': return '#section-actions'
    case 'amendment_added': return '#section-amendments'
    case 'supplement_added': return '#section-documents'
    case 'text_added': return change.newValue ? `#text-${change.newValue}` : ''
    case 'sponsor_added': case 'sponsor_removed': return '#section-sponsors'
    default: return ''
  }
}
function userEventHash(event: FeedEvent): string {
  if (event.type === 'comment_added') {
    const id = String((event.metadata as Record<string, unknown>)?.commentId ?? '')
    return id ? `#comment-${id}` : ''
  }
  return ''
}
export function userDetailLine(event: FeedEvent): string {
  const { type, metadata, userName } = event
  switch (type) {
    case 'bill_added': return `Added by ${userName}`
    case 'priority_set': return `Marked ${String(metadata.priority ?? '')} priority by ${userName}`
    case 'position_set':
      return `Position set to ${String(metadata.position ?? '')}${userName ? ` by ${userName}` : ''}`
    case 'comment_added': {
      const stored = String(metadata.preview ?? '')
      // Events written before the write site ellipsized (engagementRoutes.ts) sit
      // in the DB hard-cut at exactly COMMENT_PREVIEW_MAX with no marker, so the
      // comment reads as if it just stopped mid-word. Anything at the cap was
      // almost certainly cut — mark it here so old digests read right too.
      const preview = stripHtml(stored)
      const cut = !preview.endsWith('…') && stored.length >= COMMENT_PREVIEW_MAX
      return `${userName}: "${preview}${cut ? '…' : ''}"`
    }
    case 'vote_milestone': return String(metadata.message ?? '')
    default: return ''
  }
}
function hearingLine(event: FeedEvent): string {
  const m = event.metadata as Record<string, unknown>
  const time = formatHearingTime(m.time == null ? null : String(m.time))
  const parts = [m.date, time, m.location, m.description].map(v => (v == null ? '' : String(v))).filter(Boolean)
  const prefix = event.type === 'hearing_added' ? 'Hearing scheduled: '
    : event.type === 'hearing_cancelled' ? 'Hearing cancelled: ' : 'Hearing changed: '
  return `${prefix}${parts.join(' · ')}`
}

export function buildBillCardModel(group: GroupedBillEvents): BillCardModel {
  const rows: BillCardRow[] = []
  const inGroup = group.groupKey != null
  for (const event of group.events) {
    const ofBill = { billId: event.billId, billLabel: inGroup && event.billId !== null ? event.billNumber : null }
    if (event.type === 'bill_updated') {
      getBillUpdateChanges(event).forEach((change, idx) => {
        rows.push({
          key: `${event.id}-change-${idx}`, iconName: CHANGE_ICONS[change.changeType] ?? 'change_history',
          iconColor: color.textSecondary, iconFill: 0, text: formatBillUpdateDetail(change),
          bg: SUMMARY_BG, hash: changeRowHash(change), createdAt: event.createdAt, showTime: true,
          userId: event.userId, ...ofBill,
        })
      })
    } else if (HEARING_TYPES.has(event.type)) {
      rows.push({
        key: event.id, iconName: 'gavel', iconColor: color.billBadgeNavy, iconFill: 0,
        text: hearingLine(event), bg: SUMMARY_BG, hash: '#section-hearings',
        createdAt: event.createdAt, showTime: true, userId: event.userId, ...ofBill,
      })
    } else if (event.type === 'bill_matched') {
      // Passive, system-generated: a new keyword match became fully analyzed. Handled
      // inline (not via USER_EVENT_ICONS) so it stays out of the email-icon generator —
      // this event never appears in digest emails, only the "analyzed" feed scope.
      rows.push({
        key: event.id, iconName: 'new_releases', iconColor: color.accentBlue, iconFill: 0,
        text: 'New bill matching your keywords', bg: color.white, hash: '',
        createdAt: event.createdAt, showTime: true, userId: event.userId, ...ofBill,
      })
    } else {
      const cfg = USER_EVENT_ICONS[event.type] ?? { name: 'circle', color: color.textMuted }
      let iconColor = cfg.color
      const isPriority = event.type === 'priority_set'
      if (isPriority) iconColor = PRIORITY_COLORS[String((event.metadata as Record<string, unknown>)?.priority ?? '')]?.fill ?? iconColor
      else if (event.type === 'position_set') iconColor = POSITION_FEED_ICON[String((event.metadata as Record<string, unknown>)?.position ?? '')] ?? iconColor
      rows.push({
        key: event.id, iconName: cfg.name, iconColor, iconFill: cfg.fill ?? 0,
        text: userDetailLine(event), bg: color.white, hash: userEventHash(event),
        createdAt: event.createdAt, showTime: true, userId: event.userId, ...ofBill,
        ...(isPriority ? { square: true } : {}),
      })
    }
  }
  return {
    billNumber: group.billNumber, state: group.billState, sessionSlug: group.billSessionSlug,
    title: billDisplayTitle({ title: group.billTitle, isDraft: group.billIsDraft }), summary: group.billSummary != null ? stripMarkdown(group.billSummary) : null,
    priority: group.billPriority as 'high' | 'medium' | 'low' | null, rows,
    ...(inGroup && group.bills ? { bills: group.bills } : {}),
  }
}

export type ActivityRowModel = {
  key: string; iconName: string; iconColor: string; iconFill: 0 | 1
  text: string; createdAt: string; userId: string
  /** Render a priority square instead of a glyph (priority_set events). */
  square?: boolean
  /** How many bills the event is about, or null when it doesn't say. */
  billCount: number | null
}

/** Bills a bill-less event names, as it recorded them: the count if it stored one,
 *  else the number of ids. Null for an event that is not about bills. */
function affectedBillCount(metadata: Record<string, unknown>): number | null {
  if (typeof metadata.count === 'number') return metadata.count
  return Array.isArray(metadata.billIds) ? metadata.billIds.length : null
}

/** The single-row card for a bill-less event (a bulk edit). It is not part of a
 *  bill's card: there is no bill to head one with. */
export function buildActivityRowModel(event: FeedEvent): ActivityRowModel {
  const { metadata, type } = event
  const who = event.userName || 'An admin'
  const count = affectedBillCount(metadata)
  const onBills = count === null ? '' : ` on ${count} ${count === 1 ? 'bill' : 'bills'}`
  const base = { key: event.id, createdAt: event.createdAt, userId: event.userId, billCount: count }
  if (type === 'priority_set') {
    const priority = String(metadata.priority ?? '')
    return {
      ...base, iconName: 'flag', iconFill: 1, square: true,
      iconColor: PRIORITY_COLORS[priority]?.fill ?? USER_EVENT_ICONS.priority_set.color,
      text: `${who} set priority to ${priority}${onBills}`,
    }
  }
  if (type === 'position_set') {
    const position = metadata.position == null ? null : String(metadata.position)
    return {
      ...base, iconName: 'thumbs_up_down', iconFill: 1,
      iconColor: (position && POSITION_FEED_ICON[position]) || USER_EVENT_ICONS.position_set.color,
      text: position === null ? `${who} cleared the position${onBills}` : `${who} set position to ${position}${onBills}`,
    }
  }
  if (type === 'new_matches') {
    // The day's routine new keyword matches, written by the system, so no author to name.
    return {
      ...base, iconName: 'new_releases', iconFill: 0, iconColor: color.accentBlue,
      text: `${count ?? 0} new ${count === 1 ? 'bill' : 'bills'} matched your keywords`,
    }
  }
  return { ...base, iconName: 'circle', iconFill: 0, iconColor: color.textMuted, text: 'Activity' }
}
