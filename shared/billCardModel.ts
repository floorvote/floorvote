import { color, fontSize, fontWeight } from './tokens'
import { PRIORITY_COLORS, POSITION_FEED_ICON } from './billChipColors'
import { formatBillUpdateDetail, stripHtml, type ChangeRecord, type FeedEvent, type GroupedBillEvents } from './feedUtils'
import { formatHearingTime } from './hearingTime'
import { stripMarkdown } from './markdown'

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
}
export type BillCardModel = {
  billNumber: string; state: string | null; sessionSlug: string | null
  title: string; summary: string | null; priority: 'high' | 'medium' | 'low' | null
  rows: BillCardRow[]
}
export const CARD_STYLE = {
  headerBg: color.surfaceSubtle, border: color.borderDefault,
  badgeBg: color.billBadgeNavy, badgeColor: color.white,
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
    case 'priority_set':
      return metadata.isBulk
        ? `${userName} set ${Number(metadata.count)} bills to ${String(metadata.priority ?? '')} priority`
        : `Marked ${String(metadata.priority ?? '')} priority by ${userName}`
    case 'position_set':
      return metadata.isBulk
        ? `${userName} set position to ${String(metadata.position ?? '')} for ${Number(metadata.count)} bills`
        : `Position set to ${String(metadata.position ?? '')}${userName ? ` by ${userName}` : ''}`
    case 'comment_added': {
      const preview = stripHtml(String(metadata.preview ?? ''))
      return `${userName}: "${preview}"`
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
  for (const event of group.events) {
    if (event.type === 'bill_updated') {
      getBillUpdateChanges(event).forEach((change, idx) => {
        rows.push({
          key: `${event.id}-change-${idx}`, iconName: CHANGE_ICONS[change.changeType] ?? 'change_history',
          iconColor: color.textSecondary, iconFill: 0, text: formatBillUpdateDetail(change),
          bg: SUMMARY_BG, hash: changeRowHash(change), createdAt: event.createdAt, showTime: true,
          userId: event.userId,
        })
      })
    } else if (HEARING_TYPES.has(event.type)) {
      rows.push({
        key: event.id, iconName: 'gavel', iconColor: color.textAmberHearing, iconFill: 0,
        text: hearingLine(event), bg: SUMMARY_BG, hash: '#section-hearings',
        createdAt: event.createdAt, showTime: true, userId: event.userId,
      })
    } else if (event.type === 'bill_matched') {
      // Passive, system-generated: a new keyword match became fully analyzed. Handled
      // inline (not via USER_EVENT_ICONS) so it stays out of the email-icon generator —
      // this event never appears in digest emails, only the "analyzed" feed scope.
      rows.push({
        key: event.id, iconName: 'new_releases', iconColor: color.accentBlue, iconFill: 0,
        text: 'New bill matching your keywords', bg: color.white, hash: '',
        createdAt: event.createdAt, showTime: true, userId: event.userId,
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
        createdAt: event.createdAt, showTime: true, userId: event.userId,
        ...(isPriority ? { square: true } : {}),
      })
    }
  }
  return {
    billNumber: group.billNumber, state: group.billState, sessionSlug: group.billSessionSlug,
    title: group.billTitle, summary: group.billSummary != null ? stripMarkdown(group.billSummary) : null,
    priority: group.billPriority as 'high' | 'medium' | 'low' | null, rows,
  }
}
