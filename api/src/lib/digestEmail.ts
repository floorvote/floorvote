import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
// Email is rendered server-side with no per-user timezone, so dates are formatted in UTC.
import { PRIORITY_COLORS } from '../../../shared/billChipColors'
import { buildBillCardModel, CARD_STYLE } from '../../../shared/billCardModel'
import { prioritySquareRadius } from '../../../shared/priorityMarker'
import { emailIconSrc } from '../../../shared/emailIcons'
import { renderBillCardOpen, BILL_CARD_CLOSE } from './emailBillCard'
import { renderEmailShell, emailButton, emailFooterLink, formatDateRange } from './emailShell'
import { billUrl } from '../../../shared/sessionSlug'
import type { GroupedBillEvents, FeedEvent } from '../../../shared/feedUtils'

export type DigestEvent = {
  type: string; metadata: string; createdAt: string
  billId: string; billNumber: string; billTitle: string
  billState: string | null; billSession: string; priority: string | null
  /** The slug central assigned the bill's session. Absent = computed from billSession. */
  billSessionSlug?: string | null
  summary: string | null; userName: string | null
  /** Lets the card label an untitled draft "Untitled draft". Absent = filed. */
  billIsDraft?: boolean
}

export type NewMatchDigestItem = {
  billId: string; billNumber: string; billTitle: string
  billState: string | null; billSession: string; relevanceScore: number | null
  /** The slug central assigned the bill's session. Absent = computed from billSession. */
  billSessionSlug?: string | null
  /** The bill's tenant summary, for the card's preview. Absent or empty = no preview. */
  summary?: string | null
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) } catch { return {} }
}

// "Jun 3" — short, year-less, UTC (no per-recipient timezone in email).
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const DAY_MS = 86_400_000

function windowDays(startIso: string, endIso: string): number {
  const utc = (s: string) => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s).getTime()
  return (utc(endIso) - utc(startIso)) / DAY_MS
}

/**
 * "the last day" / "the last week" / "the last N days": names the window the
 * digest really covers (last digest → now), so a daily digest says day, a weekly
 * one says week, and a digest that skipped runs says how long it actually spans.
 * Stored timestamps are space-format UTC ("2026-06-02 11:00:00"); read them as UTC.
 */
function describeWindow(startIso: string, endIso: string): string {
  const days = windowDays(startIso, endIso)
  if (days <= 1.5) return 'the last day'
  if (days >= 5.5 && days <= 8.5) return 'the last week'
  return `the last ${Math.round(days)} days`
}

export type DigestCadence = 'daily' | 'weekly'

/** The cadence behind the period wording: a one-day window is daily, a seven-day
 *  one weekly, and any other (a digest that skipped runs) has none. */
export function digestCadence(startIso: string, endIso: string): DigestCadence | null {
  const days = windowDays(startIso, endIso)
  if (days <= 1.5) return 'daily'
  if (days >= 5.5 && days <= 8.5) return 'weekly'
  return null
}

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "Your daily digest: 2 updated bills, 3 new matches". Names only the kinds present. */
export function digestSubject(input: { updatedBills: number; newMatches: number; cadence: DigestCadence | null }): string {
  const lead = input.cadence ? `Your ${input.cadence} digest` : 'Your digest'
  const parts = [
    ...(input.updatedBills > 0 ? [countOf(input.updatedBills, 'updated bill', 'updated bills')] : []),
    ...(input.newMatches > 0 ? [countOf(input.newMatches, 'new match', 'new matches')] : []),
  ]
  return parts.length ? `${lead}: ${parts.join(', ')}` : lead
}

function toGroup(events: DigestEvent[]): GroupedBillEvents {
  const f = events[0]
  return {
    key: f.billId, billId: f.billId, billNumber: f.billNumber, billTitle: f.billTitle,
    billSessionSlug: null, billState: f.billState, billSummary: f.summary ?? null,
    billPriority: (f.priority as GroupedBillEvents['billPriority']) ?? null, billMatchType: null, date: '',
    billIsDraft: f.billIsDraft ?? false,
    events: events.map((e, i) => ({
      id: `${f.billId}-${i}`, type: e.type as FeedEvent['type'], billId: f.billId, billNumber: f.billNumber,
      billSessionSlug: null, billState: f.billState, billTitle: f.billTitle, billSummary: null,
      billPriority: (f.priority as GroupedBillEvents['billPriority']) ?? null, billMatchType: null,
      userName: e.userName ?? '', userTitle: null, metadata: safeParse(e.metadata), createdAt: e.createdAt,
    })) as FeedEvent[],
  }
}

// ⚠️ Web twin: web/src/components/GroupedBillCard.tsx is the Feed version
// of this card. Shared bits flow through buildBillCardModel/CARD_STYLE/
// PRIORITY_COLORS; this HTML layout is separate, so keep both in sync visually.
function renderBillCard(events: DigestEvent[], appUrl: string): string {
  const model = buildBillCardModel(toGroup(events))
  const first = events[0]

  // Same canonical bill URL Feed links to (/STATE/SLUG/BILL), made absolute.
  const billHref = `${appUrl}${billUrl({ id: first.billId, state: model.state, session: first.billSession, sessionSlug: first.billSessionSlug, billNumber: model.billNumber })}`
  // Links inherit surrounding color + no underline, so the card looks identical to before but is clickable (like Feed).
  const link = (href: string, inner: string) => `<a href="${escHtml(href)}" style="color:inherit;text-decoration:none;">${inner}</a>`

  // The card chrome (clickable navy badge + priority chip + serif title + summary)
  // is shared with the @-mention email via renderBillCardOpen — see emailBillCard.ts.
  // Each row below links to its deep anchor (#section-actions, #section-hearings, …) when present, else the bill.
  // Date sits on the right, mirroring Feed's showTime logic — but absolute ("Jun 3"), since email has no "now" to be relative to.
  const rowBorder = `border-top:1px solid ${CARD_STYLE.rowBorder};`
  const dataRows = model.rows.map(row => {
    const href = row.hash ? `${billHref}${row.hash}` : billHref
    const dateText = row.showTime ? escHtml(fmtDay(row.createdAt)) : ''
    // Leading marker, mirroring Feed's GroupedBillCard rows: a priority square
    // for priority_set rows, otherwise the row's pre-rendered icon PNG. iconName,
    // iconColor and iconFill are resolved by the shared buildBillCardModel, so
    // the email and the feed always agree.
    // title on the priority square gives a native hover tooltip ("High priority").
    const sqLabel = row.square ? Object.values(PRIORITY_COLORS).find(c => c.fill === row.iconColor)?.label : undefined
    const marker = row.square
      ? `<span${sqLabel ? ` title="${escHtml(sqLabel)}"` : ''} style="display:inline-block;width:11px;height:11px;border-radius:${prioritySquareRadius(11)}px;background:${row.iconColor};vertical-align:middle;"></span>`
      : `<img src="${appUrl}/email-icons/${emailIconSrc(row.iconName, row.iconColor, row.iconFill === 1)}" width="14" height="14" alt="" style="display:block;border:0;">`
    return `<tr style="background:${row.bg};">
      <td width="30" style="padding:9px 0 8px 14px;vertical-align:top;${rowBorder}">${marker}</td>
      <td style="width:100%;padding:8px 8px 8px 6px;font-size:${CARD_STYLE.rowSize}px;color:${CARD_STYLE.rowText};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.4;${rowBorder}">${link(href, escHtml(row.text))}</td>
      <td align="right" style="padding:8px 14px 8px 0;font-size:${fontSize.sm}px;color:${color.textMuted};white-space:nowrap;vertical-align:top;${rowBorder}">${dateText}</td>
    </tr>`
  }).join('\n')

  return `${renderBillCardOpen({ model, billHref, appUrl })}
    ${dataRows}${BILL_CARD_CLOSE}`
}

/** The digest shows this many new-match cards, most relevant first; past that a link goes to the full list. */
const NEW_MATCH_LIMIT = 10

// Section ids the contents box anchors to.
const UPDATES_ID = 'digest-updates'
const NEW_MATCHES_ID = 'digest-new-matches'

// Section opener: a 2px rule in the section's color, then its header (and an
// optional line under it). The id is the contents box's anchor target.
function renderSectionHeader(opts: { id: string; ruleColor: string; title: string; subtitle?: string; spaceAbove: boolean }): string {
  const subtitleRow = opts.subtitle
    ? `<tr><td style="padding:0 0 8px 0;font-size:${fontSize.xs}px;color:${color.textSecondary};">${escHtml(opts.subtitle)}</td></tr>`
    : ''
  return `
<table id="${opts.id}" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:${opts.spaceAbove ? 24 : 0}px 0 8px 0;border-top:2px solid ${opts.ruleColor};">
  <tbody>
    <tr><td style="padding:12px 0 6px 0;font-size:${fontSize.lg}px;font-weight:${fontWeight.bold};color:${color.textPrimary};">${escHtml(opts.title)}</td></tr>
    ${subtitleRow}
  </tbody>
</table>`
}

// "In this digest": one row per kind and its count, each linking to its section.
// Anchors don't work in every mail client, so the rows read as a plain summary.
function renderContentsBox(rows: { href: string; ruleColor: string; text: string }[]): string {
  const rowHtml = rows.map((r, i) => `<tr>
      <td width="16" style="padding:5px 0 ${i === rows.length - 1 ? 12 : 5}px 14px;vertical-align:middle;"><span style="display:inline-block;width:8px;height:8px;background:${r.ruleColor};border-radius:2px;"></span></td>
      <td style="padding:5px 14px ${i === rows.length - 1 ? 12 : 5}px 4px;font-size:${fontSize.base}px;color:${color.textPrimary};"><a href="${r.href}" style="color:inherit;text-decoration:none;">${escHtml(r.text)}</a></td>
    </tr>`).join('\n')
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;background:${color.white};border:1px solid ${CARD_STYLE.border};border-radius:${radius.lg}px;overflow:hidden;">
  <tbody>
    <tr><td colspan="2" style="padding:12px 14px 4px 14px;font-size:${fontSize.sm}px;font-weight:${fontWeight.semibold};color:${color.textSecondary};">In this digest</td></tr>
    ${rowHtml}
  </tbody>
</table>`
}

const NEW_MATCH_CHIP = { label: 'New match', bg: color.bgAmberPriority, text: color.textAmberWarning }

// A new match as the same card an updated bill gets, minus activity rows: badge,
// title and summary preview (none when the bill has no summary yet), with a
// "New match" chip where the priority chip goes.
function renderNewMatchCard(it: NewMatchDigestItem, appUrl: string): string {
  const model = buildBillCardModel({
    key: it.billId, billId: it.billId, billNumber: it.billNumber, billTitle: it.billTitle,
    billSessionSlug: null, billState: it.billState, billSummary: it.summary ?? null,
    billPriority: null, billMatchType: null, date: '', billIsDraft: false, events: [],
  })
  const billHref = `${appUrl}${billUrl({ id: it.billId, state: it.billState, session: it.billSession, sessionSlug: it.billSessionSlug, billNumber: it.billNumber })}`
  return `${renderBillCardOpen({ model, billHref, appUrl, chip: NEW_MATCH_CHIP })}${BILL_CARD_CLOSE}`
}

// New-match section (admins always, members who haven't opted out). Not
// priority-gated and rendered from bills (not feed events), so it lists matches
// awaiting triage. The header counts every match; only the top NEW_MATCH_LIMIT
// by relevance get a card (unscored last), with a link to the full list for the
// rest. A member can't triage, so their copy leaves off the line telling an
// admin how.
function renderNewMatchSection(items: NewMatchDigestItem[], appUrl: string, forMember: boolean, spaceAbove: boolean): string {
  if (items.length === 0) return ''
  const top = [...items]
    .sort((a, b) => (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1))
    .slice(0, NEW_MATCH_LIMIT)
  const seeAll = items.length > top.length
    ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>
  <tr><td style="padding:6px 2px 0 2px;font-size:${fontSize.sm}px;"><a href="${escHtml(`${appUrl}/bills?newMatches=1`)}" style="color:${color.accentBlue};font-weight:${fontWeight.semibold};text-decoration:none;">See all ${items.length} new matches</a></td></tr>
</tbody></table>`
    : ''
  return `${renderSectionHeader({
    id: NEW_MATCHES_ID, ruleColor: color.accentAmber, spaceAbove,
    title: countOf(items.length, 'new match', 'new matches'),
    subtitle: forMember ? undefined : 'Set a priority or dismiss each from the bill list.',
  })}
${top.map(it => renderNewMatchCard(it, appUrl)).join('\n')}${seeAll}`
}

export function renderDigestEmail(input: { events: DigestEvent[]; assocName: string; appUrl: string; periodStart?: string; periodEnd?: string; newMatches?: NewMatchDigestItem[]; forMember?: boolean }): string {
  // Group events by billId, preserving first-seen order
  const billOrder: string[] = []
  const billGroups = new Map<string, DigestEvent[]>()
  for (const event of input.events) {
    if (!billGroups.has(event.billId)) {
      billGroups.set(event.billId, [])
      billOrder.push(event.billId)
    }
    billGroups.get(event.billId)!.push(event)
  }

  const billCount = billOrder.length
  // Date range the digest covers: last digest → now (falls back to a 24h window if not supplied).
  const periodStart = input.periodStart ?? new Date(Date.now() - DAY_MS).toISOString()
  const periodEnd = input.periodEnd ?? new Date().toISOString() // ts-write-ok: formatted for email display, not a DB column
  const range = formatDateRange(fmtDay(periodStart), fmtDay(periodEnd))
  const newMatches = input.newMatches ?? []
  const hasUpdates = billCount > 0
  const hasMatches = newMatches.length > 0
  const window = describeWindow(periodStart, periodEnd)
  // Both kinds: the headline names the digest and the contents box below names the kinds.
  // One kind: the headline says what happened, as before.
  const signal = hasUpdates && hasMatches
    ? `Your digest for ${window}`
    : hasUpdates
      ? `${countOf(billCount, 'priority bill', 'priority bills')} ${billCount === 1 ? 'was' : 'were'} updated in ${window}`
      : `${countOf(newMatches.length, 'new match', 'new matches')} in ${window}`
  const contentsBox = hasUpdates && hasMatches
    ? renderContentsBox([
        { href: `#${UPDATES_ID}`, ruleColor: color.billBadgeNavy, text: `${countOf(billCount, 'priority bill', 'priority bills')} updated` },
        { href: `#${NEW_MATCHES_ID}`, ruleColor: color.accentAmber, text: countOf(newMatches.length, 'new match', 'new matches') },
      ])
    : ''
  const updatesSection = hasUpdates
    ? `${renderSectionHeader({ id: UPDATES_ID, ruleColor: color.billBadgeNavy, spaceAbove: false, title: `${countOf(billCount, 'priority bill', 'priority bills')} ${billCount === 1 ? 'was' : 'were'} updated` })}
${billOrder.map(id => renderBillCard(billGroups.get(id)!, input.appUrl)).join('\n')}`
    : ''
  const newMatchSection = renderNewMatchSection(newMatches, input.appUrl, input.forMember ?? false, hasUpdates)
  const ctaHtml = hasUpdates
    ? emailButton(`${input.appUrl}/bills`, 'View bill updates')
    : emailButton(`${input.appUrl}/bills?newMatches=1`, 'View newly matched bills')

  return renderEmailShell({
    instanceName: input.assocName,
    appUrl: input.appUrl,
    signalHtml: escHtml(signal),
    dateLabel: range,
    bodyHtml: `${contentsBox}${updatesSection}\n${newMatchSection}`,
    ctaHtml,
    footerHtml: emailFooterLink(`${input.appUrl}/profile#setting-email-digest`, 'Manage email settings'),
  })
}
