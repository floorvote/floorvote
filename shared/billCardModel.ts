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
  // A custom field change. The feed has no row for one yet, so only the bill page's comment thread draws it,
  // in the same muted color as an amendment row (textSecondary) so the email icon set needs no new PNG.
  custom_field_set: { name: 'edit_note',  color: color.textSecondary },
}

/** `hollow` marks a cleared priority: the square is drawn empty, outlined in `color`, like the "no priority" look. */
export type UserEventIcon = { name: string; color: string; fill: 0 | 1; square: boolean; hollow?: true }

/**
 * The icon a person's change shows with, in one place for every surface that draws it: the feed's card rows,
 * a bulk edit's row, and the bill page's comment thread (the digest email reads USER_EVENT_ICONS for its PNGs).
 * A priority change is a square in the priority's color, not a glyph (`square`). A position change is a glyph
 * in the position's color. A type or value the tables have no color for keeps the table's own.
 */
export function userEventIcon(type: string, metadata?: Record<string, unknown> | null): UserEventIcon {
  const cfg = USER_EVENT_ICONS[type] ?? { name: 'circle', color: color.textMuted }
  let iconColor = cfg.color
  // A cleared priority is an empty square with the border the priority dropdown's "none" has, not a color.
  const cleared = type === 'priority_set' && metadata != null && metadata.priority == null
  if (cleared) iconColor = color.borderDefault
  else if (type === 'priority_set') iconColor = PRIORITY_COLORS[String(metadata?.priority ?? '')]?.fill ?? iconColor
  else if (type === 'position_set') iconColor = POSITION_FEED_ICON[String(metadata?.position ?? '')] ?? iconColor
  return { name: cfg.name, color: iconColor, fill: cfg.fill ?? 0, square: type === 'priority_set', ...(cleared ? { hollow: true as const } : {}) }
}
const HEARING_TYPES = new Set(['hearing_added', 'hearing_changed', 'hearing_cancelled'])

export type BillCardRow = {
  key: string; iconName: string; iconColor: string; iconFill: 0 | 1
  text: string; bg: string; hash: string; createdAt: string; showTime: boolean
  userId: string
  /** When true, render a priority square instead of a glyph (priority_set events). */
  square?: boolean
  /** With `square`: draw it empty, outlined in `iconColor` (a cleared priority). */
  hollow?: boolean
  /** The bill the row's event is on, so a row in a companion group's card opens its own bill. */
  billId: string | null
  /**
   * The number of the bill the row's event is on, shown in front of the text, in
   * a companion group's card whose header shows more than one bill, so each row
   * says which of them it happened on. Null in a bill's own card, and in a group's
   * card with one bill in its header, where the chip already names it.
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

/** A row's text as it reads in a card: in front of it, the number of its bill when the card's header shows several. */
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
  // With one bill in the header, its chip already says which bill every row is on.
  const labelRows = inGroup && (group.bills?.length ?? 0) > 1
  for (const event of group.events) {
    const ofBill = { billId: event.billId, billLabel: labelRows && event.billId !== null ? event.billNumber : null }
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
      // this event never appears in digest emails, only on the card of a bill with a priority.
      rows.push({
        key: event.id, iconName: 'new_releases', iconColor: color.accentBlue, iconFill: 0,
        text: 'New bill matching your keywords', bg: color.white, hash: '',
        createdAt: event.createdAt, showTime: true, userId: event.userId, ...ofBill,
      })
    } else {
      const icon = userEventIcon(event.type, event.metadata as Record<string, unknown>)
      rows.push({
        key: event.id, iconName: icon.name, iconColor: icon.color, iconFill: icon.fill,
        text: userDetailLine(event), bg: color.white, hash: userEventHash(event),
        createdAt: event.createdAt, showTime: true, userId: event.userId, ...ofBill,
        ...(icon.square ? { square: true } : {}),
        ...(icon.hollow ? { hollow: true } : {}),
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
  /** With `square`: draw it empty, outlined in `iconColor` (a cleared priority). */
  hollow?: boolean
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
    const icon = userEventIcon(type, metadata)
    return {
      ...base, iconName: icon.name, iconFill: icon.fill, square: true, iconColor: icon.color, ...(icon.hollow ? { hollow: true } : {}),
      text: `${who} set priority to ${priority}${onBills}`,
    }
  }
  if (type === 'position_set') {
    const position = metadata.position == null ? null : String(metadata.position)
    const icon = userEventIcon(type, metadata)
    return {
      ...base, iconName: icon.name, iconFill: icon.fill, iconColor: icon.color,
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
