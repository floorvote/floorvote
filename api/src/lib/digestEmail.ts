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
  summary: string | null; userName: string | null
}

export type NewMatchDigestItem = {
  billId: string; billNumber: string; billTitle: string
  billState: string | null; billSession: string; relevanceScore: number | null
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

function toGroup(events: DigestEvent[]): GroupedBillEvents {
  const f = events[0]
  return {
    key: f.billId, billId: f.billId, billNumber: f.billNumber, billTitle: f.billTitle,
    billSessionSlug: null, billState: f.billState, billSummary: f.summary ?? null,
    billPriority: (f.priority as GroupedBillEvents['billPriority']) ?? null, billMatchType: null, date: '',
    events: events.map((e, i) => ({
      id: `${f.billId}-${i}`, type: e.type as FeedEvent['type'], billId: f.billId, billNumber: f.billNumber,
      billSessionSlug: null, billState: f.billState, billTitle: f.billTitle, billSummary: null,
      billPriority: (f.priority as GroupedBillEvents['billPriority']) ?? null, billMatchType: null,
      userName: e.userName ?? '', userSubtitle: null, metadata: safeParse(e.metadata), createdAt: e.createdAt,
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
  const billHref = `${appUrl}${billUrl({ id: first.billId, state: model.state, session: first.billSession, billNumber: model.billNumber })}`
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

// New keyword-match section (admin/owner digests only). Not priority-gated and
// rendered from bills (not feed events), so it lists matches awaiting triage.
function renderNewMatchSection(items: NewMatchDigestItem[], appUrl: string): string {
  if (items.length === 0) return ''
  const rows = items.map(it => {
    const href = `${appUrl}${billUrl({ id: it.billId, state: it.billState, session: it.billSession, billNumber: it.billNumber })}`
    const badgeText = it.billState ? `${escHtml(it.billState)} ${escHtml(it.billNumber)}` : escHtml(it.billNumber)
    return `<tr>
      <td style="padding:8px 0;border-top:1px solid ${color.borderDefault};">
        <a href="${escHtml(href)}" style="text-decoration:none;">
          <span style="display:inline-block;background:${CARD_STYLE.badgeBg};color:${CARD_STYLE.badgeColor};font-size:${fontSize.sm}px;font-weight:${fontWeight.bold};padding:3px 10px;border-radius:${radius.sm}px;letter-spacing:0.02em;">${badgeText}</span>
          <span style="color:${color.textPrimary};font-size:${fontSize.sm}px;font-family:${CARD_STYLE.titleFontFamily};margin-left:8px;">${escHtml(it.billTitle)}</span>
        </a>
      </td>
    </tr>`
  }).join('\n')
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;border:1px solid ${color.borderDefault};border-radius:${radius.lg}px;overflow:hidden;">
  <tbody>
    <tr><td style="padding:12px 14px 4px 14px;background:${color.surfaceSubtle};font-size:${fontSize.base}px;font-weight:${fontWeight.bold};color:${color.textPrimary};">New bills matching your keywords</td></tr>
    <tr><td style="padding:0 14px 6px 14px;background:${color.surfaceSubtle};font-size:${fontSize.xs}px;color:${color.textSecondary};">Set a priority or dismiss each from the bill list.</td></tr>
    <tr><td style="padding:0 14px 8px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>${rows}</tbody></table>
    </td></tr>
  </tbody>
</table>`
}

export function renderDigestEmail(input: { events: DigestEvent[]; assocName: string; appUrl: string; periodStart?: string; periodEnd?: string; newMatches?: NewMatchDigestItem[] }): string {
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
  const start = fmtDay(input.periodStart ?? new Date(Date.now() - 86400_000).toISOString())
  const end = fmtDay(input.periodEnd ?? new Date().toISOString()) // ts-write-ok: formatted for email display, not a DB column
  const range = formatDateRange(start, end)
  const newMatches = input.newMatches ?? []
  const signal = billCount > 0
    ? `${billCount} priority ${billCount === 1 ? 'bill' : 'bills'} ${billCount === 1 ? 'was' : 'were'} updated in the last week`
    : `${newMatches.length} new keyword ${newMatches.length === 1 ? 'match' : 'matches'}`
  const newMatchSection = renderNewMatchSection(newMatches, input.appUrl)
  const cards = billOrder.map(id => renderBillCard(billGroups.get(id)!, input.appUrl)).join('\n')
  const ctaHtml = billCount > 0
    ? emailButton(`${input.appUrl}/bills`, 'View bill updates')
    : emailButton(`${input.appUrl}/bills?newMatches=1`, 'View newly matched bills')

  return renderEmailShell({
    instanceName: input.assocName,
    appUrl: input.appUrl,
    signalHtml: escHtml(signal),
    dateLabel: range,
    bodyHtml: `${newMatchSection}\n${cards}`,
    ctaHtml,
    footerHtml: emailFooterLink(`${input.appUrl}/profile#setting-email-digest`, 'Manage email settings'),
  })
}
