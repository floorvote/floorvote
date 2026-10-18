import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
// Email is rendered server-side with no per-user timezone, so dates are formatted in UTC.
import { PRIORITY_COLORS } from '../../../shared/billChipColors'
import { buildBillCardModel, billCardRowText, CARD_STYLE } from '../../../shared/billCardModel'
import { prioritySquareRadius } from '../../../shared/priorityMarker'
import { emailIconSrc } from '../../../shared/emailIcons'
import { renderBillCardOpen, BILL_CARD_CLOSE } from './emailBillCard'
import { renderEmailShell, emailButton, emailFooterLink, formatDateRange } from './emailShell'
import { billUrl } from '../../../shared/sessionSlug'
import { dbTsToEpoch } from '../../../shared/time'
import type { GroupedBillEvents, GroupedBill, FeedEvent } from '../../../shared/feedUtils'

export type DigestEvent = {
  type: string; metadata: string; createdAt: string
  billId: string; billNumber: string; billTitle: string
  billState: string | null; billSession: string; priority: string | null
  /** The slug central assigned the bill's session. Absent = computed from billSession. */
  billSessionSlug?: string | null
  summary: string | null; userName: string | null
  /** Lets the card label an untitled draft "Untitled draft". Absent = filed. */
  billIsDraft?: boolean
  /** The key of the bill's companion group. Events on any member share a card. Absent or null = in no group. */
  billGroupKey?: string | null
}

/**
 * What an event's card is for: its bill, or its companion group, since a group
 * is one policy and its members' events share one card. One card per key, so
 * the count of keys is the count of "priority bills" the digest reports.
 */
export function digestCardKey(e: Pick<DigestEvent, 'billId' | 'billGroupKey'>): string {
  return e.billGroupKey ? `group:${e.billGroupKey}` : e.billId
}

/** How many priority bills the digest reports for these events: one per card, so a group counts once however many of its bills changed. */
export function countUpdatedBills(events: readonly Pick<DigestEvent, 'billId' | 'billGroupKey'>[]): number {
  return new Set(events.map(digestCardKey)).size
}

export type NewMatchDigestItem = {
  billId: string; billNumber: string; billTitle: string
  billState: string | null; billSession: string; relevanceScore: number | null
  /** The slug central assigned the bill's session. Absent = computed from billSession. */
  billSessionSlug?: string | null
  /** The bill's tenant summary, for the card's preview. Absent or empty = no preview. */
  summary?: string | null
  /** The key of the bill's companion group. Members of one group share a card and count once. Absent or null = in no group. */
  billGroupKey?: string | null
}

/** A new match as the digest shows it: one bill, or one companion group of them. `head` is the bill the card opens, the group's most relevant member. */
type NewMatchCard = { head: NewMatchDigestItem; members: NewMatchDigestItem[]; summary: string | null }

const byRelevance = (a: NewMatchDigestItem, b: NewMatchDigestItem) => (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1)

// A companion group is one policy, so its matched members are one new match
// (#638), as its updated bills are one card (#381). Cards come out in the order
// each key is first seen. Members are most relevant first, and the group's
// summary is the head's own, else the first companion's that has one.
function toNewMatchCards(items: readonly NewMatchDigestItem[]): NewMatchCard[] {
  const byKey = new Map<string, NewMatchDigestItem[]>()
  for (const it of items) {
    const key = it.billGroupKey ? `group:${it.billGroupKey}` : it.billId
    byKey.set(key, [...(byKey.get(key) ?? []), it])
  }
  return [...byKey.values()].map(group => {
    const members = [...group].sort(byRelevance)
    return { head: members[0], members, summary: members.find(m => m.summary)?.summary ?? null }
  })
}

/** How many new matches the digest reports for these bills: one per card, so a companion group counts once however many of its bills matched. */
export function countNewMatches(items: readonly NewMatchDigestItem[]): number {
  return toNewMatchCards(items).length
}

/**
 * A saved view a member has included in their digest, with what is new in it (#449): the activity on its
 * bills in the digest's window, and the bills that entered the instance in the window and meet its filter.
 * Neither includes a bill the digest already shows as a priority bill. A view with neither is left out.
 */
export type ViewDigestSection = {
  viewId: string; name: string
  /** The view's slug, for the link to the view in the bill list. */
  slug: string
  events: DigestEvent[]
  newBills: NewMatchDigestItem[]
}

/** The digest lists this many cards of a view, then "and N more" linking to the view. */
const VIEW_LIMIT = 5

// A view's cards: its activity first, as the priority section's cards are (one per bill or companion group),
// then bills that entered it, most relevant first. A bill with both is its activity's card alone.
function toViewCards(section: ViewDigestSection): { key: string; events?: DigestEvent[]; card?: NewMatchCard }[] {
  const byKey = new Map<string, DigestEvent[]>()
  for (const e of section.events) byKey.set(digestCardKey(e), [...(byKey.get(digestCardKey(e)) ?? []), e])
  const entered = toNewMatchCards(section.newBills)
    .filter(card => !byKey.has(card.head.billGroupKey ? `group:${card.head.billGroupKey}` : card.head.billId))
    .sort((a, b) => byRelevance(a.head, b.head))
  return [
    ...[...byKey].map(([key, events]) => ({ key, events })),
    ...entered.map(card => ({ key: card.head.billGroupKey ? `group:${card.head.billGroupKey}` : card.head.billId, card })),
  ]
}

/** How many cards a view has in the digest: one per bill or companion group that moved in it or entered it. */
export function countViewCards(section: ViewDigestSection): number {
  return toViewCards(section).length
}

/** How many bills in saved views the digest reports across a member's views: a bill in two of them counts once, a companion group once. */
export function countViewBills(sections: readonly ViewDigestSection[]): number {
  return new Set(sections.flatMap(s => toViewCards(s).map(c => c.key))).size
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

/** "Your daily digest: 2 updated bills, 3 new matches, 4 bills in your saved views". Names only the kinds present. */
export function digestSubject(input: { updatedBills: number; newMatches: number; viewBills?: number; cadence: DigestCadence | null }): string {
  const lead = input.cadence ? `Your ${input.cadence} digest` : 'Your digest'
  const parts = [
    ...(input.updatedBills > 0 ? [countOf(input.updatedBills, 'updated bill', 'updated bills')] : []),
    ...(input.newMatches > 0 ? [countOf(input.newMatches, 'new match', 'new matches')] : []),
    ...((input.viewBills ?? 0) > 0 ? [countOf(input.viewBills!, 'bill in your saved views', 'bills in your saved views')] : []),
  ]
  return parts.length ? `${lead}: ${parts.join(', ')}` : lead
}

// The card's model. A bill's own card is as it always was. A companion group's card holds
// the events of every member, in time order, each naming its bill, and is headed by the
// bill of the newest event (as the Feed's is), with the rest listed beside it.
function toGroup(inputEvents: DigestEvent[]): GroupedBillEvents {
  const groupKey = inputEvents[0].billGroupKey || null
  const events = groupKey === null
    ? inputEvents
    : [...inputEvents].sort((a, b) => dbTsToEpoch(a.createdAt) - dbTsToEpoch(b.createdAt))
  const f = groupKey === null ? events[0] : events[events.length - 1]
  const bills: GroupedBill[] = []
  for (const e of groupKey === null ? [] : [...events].reverse()) {
    if (!bills.some(b => b.billId === e.billId)) {
      bills.push({ billId: e.billId, billNumber: e.billNumber, billState: e.billState, billSessionSlug: null, billIsDraft: e.billIsDraft ?? false })
    }
  }
  return {
    key: groupKey === null ? f.billId : `group:${groupKey}`, billId: f.billId, billNumber: f.billNumber, billTitle: f.billTitle,
    billSessionSlug: null, billState: f.billState,
    // A group's summary is its analysis's: the newest event's bill's own when it has one, else a companion's.
    billSummary: f.summary ?? (groupKey === null ? null : ([...events].reverse().find(e => e.summary)?.summary ?? null)),
    billPriority: (f.priority as GroupedBillEvents['billPriority']) ?? null, billMatchType: null, date: '',
    billIsDraft: f.billIsDraft ?? false,
    groupKey, ...(groupKey === null ? {} : { bills }),
    events: events.map((e, i) => ({
      id: `${e.billId}-${i}`, type: e.type as FeedEvent['type'], billId: e.billId, billNumber: e.billNumber,
      billSessionSlug: null, billState: e.billState, billTitle: e.billTitle, billSummary: null,
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

  // Same canonical bill URL Feed links to (/STATE/SLUG/BILL), made absolute.
  const hrefOf = (e: DigestEvent) => `${appUrl}${billUrl({ id: e.billId, state: e.billState, session: e.billSession, sessionSlug: e.billSessionSlug, billNumber: e.billNumber })}`
  const eventOfBill = (billId: string | null) => events.find(e => e.billId === billId)
  // The card opens its header bill; a row opens the bill its event is on.
  const first = eventOfBill(model.bills?.[0]?.billId ?? events[0].billId) ?? events[0]
  const billHref = hrefOf(first)
  const rowHref = (billId: string | null) => { const e = eventOfBill(billId); return e ? hrefOf(e) : billHref }
  // A companion group's other bills, as badges beside the first.
  const otherBadges = (model.bills ?? []).slice(1).flatMap(b => {
    const e = eventOfBill(b.billId)
    return e ? [{ text: e.billState ? `${e.billState} ${e.billNumber}` : e.billNumber, href: hrefOf(e) }] : []
  })
  // Links inherit surrounding color + no underline, so the card looks identical to before but is clickable (like Feed).
  const link = (href: string, inner: string) => `<a href="${escHtml(href)}" style="color:inherit;text-decoration:none;">${inner}</a>`

  // The card chrome (clickable navy badge + priority chip + serif title + summary)
  // is shared with the @-mention email via renderBillCardOpen — see emailBillCard.ts.
  // Each row below links to its deep anchor (#section-actions, #section-hearings, …) when present, else the bill.
  // Date sits on the right, mirroring Feed's showTime logic — but absolute ("Jun 3"), since email has no "now" to be relative to.
  const rowBorder = `border-top:1px solid ${CARD_STYLE.rowBorder};`
  const dataRows = model.rows.map(row => {
    const ownHref = rowHref(row.billId)
    const href = row.hash ? `${ownHref}${row.hash}` : ownHref
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
      <td style="width:100%;padding:8px 8px 8px 6px;font-size:${CARD_STYLE.rowSize}px;color:${CARD_STYLE.rowText};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.4;${rowBorder}">${link(href, escHtml(billCardRowText(row)))}</td>
      <td align="right" style="padding:8px 14px 8px 0;font-size:${fontSize.sm}px;color:${color.textMuted};white-space:nowrap;vertical-align:top;${rowBorder}">${dateText}</td>
    </tr>`
  }).join('\n')

  return `${renderBillCardOpen({ model, billHref, appUrl, otherBadges })}
    ${dataRows}${BILL_CARD_CLOSE}`
}

/** The digest shows this many new-match cards, most relevant first; past that a link goes to the full list. */
const NEW_MATCH_LIMIT = 10

// Section ids the contents box anchors to.
const UPDATES_ID = 'digest-updates'
const NEW_MATCHES_ID = 'digest-new-matches'
const viewSectionId = (i: number) => `digest-view-${i}`

// A bill that entered a view, as the chip says. A view's cards carry no "Set priority" link, which is the triage worklist's.
const VIEW_ENTRY_CHIP = { label: 'New in view', bg: color.bgAmberPriority, text: color.textAmberWarning }

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
function renderNewMatchCard(card: NewMatchCard, appUrl: string, forMember: boolean, chip: { label: string; bg: string; text: string } = NEW_MATCH_CHIP): string {
  const it = card.head
  const hrefOf = (m: NewMatchDigestItem) => `${appUrl}${billUrl({ id: m.billId, state: m.billState, session: m.billSession, sessionSlug: m.billSessionSlug, billNumber: m.billNumber })}`
  const model = buildBillCardModel({
    key: it.billId, billId: it.billId, billNumber: it.billNumber, billTitle: it.billTitle,
    billSessionSlug: null, billState: it.billState, billSummary: card.summary,
    billPriority: null, billMatchType: null, date: '', billIsDraft: false, events: [],
  })
  const billHref = hrefOf(it)
  // A companion group's other matched bills, as badges beside the first.
  const otherBadges = card.members.slice(1).map(m => ({ text: m.billState ? `${m.billState} ${m.billNumber}` : m.billNumber, href: hrefOf(m) }))
  // The bill page is where the amber "New · Set priority" dropdown is. A member
  // can't set a priority, so their cards carry no link.
  const setPriority = forMember ? '' : `
    <tr style="background:${color.white};"><td colspan="3" style="padding:8px 14px 10px 14px;border-top:1px solid ${CARD_STYLE.rowBorder};font-size:${fontSize.sm}px;"><a href="${escHtml(billHref)}" style="color:${color.accentBlue};font-weight:${fontWeight.semibold};text-decoration:none;">Set priority</a></td></tr>`
  return `${renderBillCardOpen({ model, billHref, appUrl, chip, otherBadges })}${setPriority}${BILL_CARD_CLOSE}`
}

// New-match section (admins always, members who haven't opted out). Not
// priority-gated and rendered from bills (not feed events), so it lists matches
// awaiting triage. The header counts every match; only the top NEW_MATCH_LIMIT
// by relevance get a card (unscored last), with a link to the full list for the
// rest. A member can't triage, so their copy leaves off the line telling an
// admin how.
function renderNewMatchSection(items: NewMatchDigestItem[], appUrl: string, forMember: boolean, spaceAbove: boolean): string {
  const cards = toNewMatchCards(items)
  if (cards.length === 0) return ''
  const top = [...cards]
    .sort((a, b) => byRelevance(a.head, b.head))
    .slice(0, NEW_MATCH_LIMIT)
  const seeAll = cards.length > top.length
    ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>
  <tr><td style="padding:6px 2px 0 2px;font-size:${fontSize.sm}px;"><a href="${escHtml(`${appUrl}/bills?newMatches=1`)}" style="color:${color.accentBlue};font-weight:${fontWeight.semibold};text-decoration:none;">See all ${cards.length} new matches</a></td></tr>
</tbody></table>`
    : ''
  return `${renderSectionHeader({
    id: NEW_MATCHES_ID, ruleColor: color.accentAmber, spaceAbove,
    title: countOf(cards.length, 'new match', 'new matches'),
    subtitle: forMember ? undefined : 'Set a priority or dismiss each from the bill list.',
  })}
${top.map(card => renderNewMatchCard(card, appUrl, forMember)).join('\n')}${seeAll}`
}

// "In your Transportation view": the view's cards, capped at VIEW_LIMIT, then "and N more" linking to the view.
function renderViewSection(section: ViewDigestSection, index: number, appUrl: string, spaceAbove: boolean): string {
  const cards = toViewCards(section)
  if (cards.length === 0) return ''
  const html = cards.slice(0, VIEW_LIMIT).map(c => c.events
    ? renderBillCard(c.events, appUrl)
    : renderNewMatchCard(c.card!, appUrl, true, VIEW_ENTRY_CHIP)).join('\n')
  const rest = cards.length - VIEW_LIMIT
  const more = rest > 0
    ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>
  <tr><td style="padding:6px 2px 0 2px;font-size:${fontSize.sm}px;"><a href="${escHtml(`${appUrl}/bills?view=${encodeURIComponent(section.slug)}`)}" style="color:${color.accentBlue};font-weight:${fontWeight.semibold};text-decoration:none;">and ${rest} more</a></td></tr>
</tbody></table>`
    : ''
  return `${renderSectionHeader({ id: viewSectionId(index), ruleColor: color.accentBlue, spaceAbove, title: `In your ${section.name} view` })}
${html}${more}`
}

export function renderDigestEmail(input: { events: DigestEvent[]; assocName: string; appUrl: string; periodStart?: string; periodEnd?: string; newMatches?: NewMatchDigestItem[]; views?: ViewDigestSection[]; forMember?: boolean }): string {
  // Group events by card (a bill, or its companion group), preserving first-seen order
  const billOrder: string[] = []
  const billGroups = new Map<string, DigestEvent[]>()
  for (const event of input.events) {
    const key = digestCardKey(event)
    if (!billGroups.has(key)) {
      billGroups.set(key, [])
      billOrder.push(key)
    }
    billGroups.get(key)!.push(event)
  }

  const billCount = billOrder.length
  // Date range the digest covers: last digest → now (falls back to a 24h window if not supplied).
  const periodStart = input.periodStart ?? new Date(Date.now() - DAY_MS).toISOString()
  const periodEnd = input.periodEnd ?? new Date().toISOString() // ts-write-ok: formatted for email display, not a DB column
  const range = formatDateRange(fmtDay(periodStart), fmtDay(periodEnd))
  const newMatches = input.newMatches ?? []
  const matchCount = countNewMatches(newMatches)
  const hasUpdates = billCount > 0
  const hasMatches = matchCount > 0
  // A view with nothing new is left out. The rest keep their order, and their anchors number the sections shown.
  const views = (input.views ?? []).filter(v => countViewCards(v) > 0)
  const viewBillCount = countViewBills(views)
  const hasViews = views.length > 0
  const window = describeWindow(periodStart, periodEnd)
  // More than one kind: the headline names the digest and the contents box below names the kinds.
  // One kind: the headline says what happened, as before.
  const kinds = [hasUpdates, hasMatches, hasViews].filter(Boolean).length
  const signal = kinds > 1
    ? `Your digest for ${window}`
    : hasUpdates
      ? `${countOf(billCount, 'priority bill', 'priority bills')} ${billCount === 1 ? 'was' : 'were'} updated in ${window}`
      : hasViews
        ? `${countOf(viewBillCount, 'bill', 'bills')} in your saved ${views.length === 1 ? 'view' : 'views'} in ${window}`
        : `${countOf(matchCount, 'new match', 'new matches')} in ${window}`
  const contentsBox = kinds > 1
    ? renderContentsBox([
        ...(hasUpdates ? [{ href: `#${UPDATES_ID}`, ruleColor: color.billBadgeNavy, text: `${countOf(billCount, 'priority bill', 'priority bills')} updated` }] : []),
        ...(hasMatches ? [{ href: `#${NEW_MATCHES_ID}`, ruleColor: color.accentAmber, text: countOf(matchCount, 'new match', 'new matches') }] : []),
        ...views.map((v, i) => ({ href: `#${viewSectionId(i)}`, ruleColor: color.accentBlue, text: `${countOf(countViewCards(v), 'bill', 'bills')} in ${v.name}` })),
      ])
    : ''
  const updatesSection = hasUpdates
    ? `${renderSectionHeader({ id: UPDATES_ID, ruleColor: color.billBadgeNavy, spaceAbove: false, title: `${countOf(billCount, 'priority bill', 'priority bills')} ${billCount === 1 ? 'was' : 'were'} updated` })}
${billOrder.map(id => renderBillCard(billGroups.get(id)!, input.appUrl)).join('\n')}`
    : ''
  const newMatchSection = renderNewMatchSection(newMatches, input.appUrl, input.forMember ?? false, hasUpdates)
  const viewSections = views.map((v, i) => renderViewSection(v, i, input.appUrl, hasUpdates || hasMatches || i > 0)).join('\n')
  const ctaHtml = hasUpdates
    ? emailButton(`${input.appUrl}/bills`, 'View bill updates')
    : hasMatches || !hasViews
      ? emailButton(`${input.appUrl}/bills?newMatches=1`, 'View newly matched bills')
      : emailButton(views.length === 1 ? `${input.appUrl}/bills?view=${encodeURIComponent(views[0].slug)}` : `${input.appUrl}/bills`, 'View in the bill list')

  return renderEmailShell({
    instanceName: input.assocName,
    appUrl: input.appUrl,
    signalHtml: escHtml(signal),
    dateLabel: range,
    bodyHtml: `${contentsBox}${updatesSection}\n${newMatchSection}${viewSections ? `\n${viewSections}` : ''}`,
    ctaHtml,
    footerHtml: emailFooterLink(`${input.appUrl}/profile#setting-email-digest`, 'Manage email settings'),
  })
}
