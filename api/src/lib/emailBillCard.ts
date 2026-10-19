import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
import { PRIORITY_COLORS } from '../../../shared/billChipColors'
import { CARD_STYLE, type BillCardModel } from '../../../shared/billCardModel'
import { COMMENT_STYLE } from '../../../shared/commentStyle'
import { emailIconSrc } from '../../../shared/emailIcons'
import { dbTsToEpoch } from '../../../shared/time'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Links inherit surrounding color + no underline, so the card looks identical
// to a static card but is clickable (matches the Feed / digest).
const link = (href: string, inner: string) => `<a href="${escHtml(href)}" style="color:inherit;text-decoration:none;">${inner}</a>`

// UTC absolute date in BillDetail's `absoluteTime` style. Email has no
// per-recipient timezone, so we format in UTC (like the digest's fmtDay).
export function formatEmailDateTime(iso: string): string {
  return new Date(dbTsToEpoch(iso)).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  })
}

// Card chrome shared with the digest (digestEmail.renderBillCard). Renders the
// table-open through the summary row; the caller appends rows + BILL_CARD_CLOSE.
// `chip` replaces the priority chip in the top-right with another label (the
// digest's "New match"); it takes the priority chip's padding and radius.
export type BillCardChip = { label: string; bg: string; text: string; /** A border color, drawn as 1px solid. */ border?: string; /** Makes the chip a link. */ href?: string }

/** A bill's badge beside the first, in a companion group's card. */
export type BillCardBadge = { text: string; href: string }

export function renderBillCardOpen({ model, billHref, chip, otherBadges = [] }: { model: BillCardModel; billHref: string; appUrl: string; chip?: BillCardChip; otherBadges?: BillCardBadge[] }): string {
  const pc = model.priority ? PRIORITY_COLORS[model.priority] : null
  const badgeText = model.state ? `${escHtml(model.state)} ${escHtml(model.billNumber)}` : escHtml(model.billNumber)
  const badge = link(billHref, `<span style="display:inline-block;background:${CARD_STYLE.badgeBg};color:${CARD_STYLE.badgeColor};font-size:${fontSize.sm}px;font-weight:${fontWeight.bold};padding:3px 10px;border-radius:${radius.sm}px;letter-spacing:0.02em;">${badgeText}</span>`)
  const badgeStyle = `display:inline-block;background:${CARD_STYLE.badgeBg};color:${CARD_STYLE.badgeColor};font-size:${fontSize.sm}px;font-weight:${fontWeight.bold};padding:3px 10px;border-radius:${radius.sm}px;letter-spacing:0.02em;`
  const badges = [badge, ...otherBadges.map(b => link(b.href, `<span style="${badgeStyle}margin-left:6px;">${escHtml(b.text)}</span>`))].join('')
  const chipSpec = chip ?? (pc ? { label: pc.label, bg: pc.fill, text: pc.text } : null)
  const chipBorder = chipSpec && 'border' in chipSpec && chipSpec.border ? `border:1px solid ${chipSpec.border};` : ''
  const chipSpan = chipSpec
    ? `<span style="display:inline-block;background:${chipSpec.bg};color:${chipSpec.text};${chipBorder}font-size:${fontSize.sm}px;font-weight:${fontWeight.semibold};padding:3px 10px;border-radius:${radius.sm}px;white-space:nowrap;">${escHtml(chipSpec.label)}</span>`
    : ''
  const priorityChip = chipSpec && 'href' in chipSpec && chipSpec.href ? link(chipSpec.href, chipSpan) : chipSpan
  const titlePadBottom = model.summary ? 4 : 10
  const summaryRow = model.summary
    ? `<tr style="background:${CARD_STYLE.headerBg};"><td colspan="3" style="padding:0 14px 10px 14px;font-size:${CARD_STYLE.summarySize}px;color:${CARD_STYLE.summaryColor};font-family:${CARD_STYLE.summaryFontFamily};line-height:1.45;">${link(billHref, escHtml(model.summary))}</td></tr>`
    : ''
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${color.white};margin-bottom:8px;border-radius:${radius.lg}px;overflow:hidden;border:1px solid ${CARD_STYLE.border};box-shadow:${CARD_STYLE.shadow};">
  <tbody>
    <tr style="background:${CARD_STYLE.headerBg};">
      <td colspan="3" style="padding:12px 14px 8px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody><tr>
          <td align="left" style="vertical-align:middle;">${badges}</td>
          <td align="right" style="vertical-align:middle;">${priorityChip}</td>
        </tr></tbody></table>
      </td>
    </tr>
    <tr style="background:${CARD_STYLE.headerBg};">
      <td colspan="3" style="padding:2px 14px ${titlePadBottom}px 14px;font-family:${CARD_STYLE.titleFontFamily};font-size:${CARD_STYLE.titleSize}px;color:${CARD_STYLE.titleColor};font-weight:${CARD_STYLE.titleWeight};line-height:1.35;">${link(billHref, escHtml(model.title))}</td>
    </tr>
    ${summaryRow}`
}

export const BILL_CARD_CLOSE = `
  </tbody>
</table>`

// Comment as a card row: Feed's purple chat icon + the BillDetail comment
// header (name / title / date) + the full comment body indented under the
// name (Feed's indented-row look). bodyHtml is already styled HTML.
//
// ⚠️ Web twin: web/src/pages/BillDetail.tsx renders the same comment header.
// Both pull sizes/weights/colors from the shared COMMENT_STYLE so they can't
// drift. Each span sets its size explicitly — without it the title and the
// tiptap <p> body would inherit the email's 16px default and look oversized.
export function renderCommentRow({ appUrl, name, title, dateText, bodyHtml }: { appUrl: string; name: string; title: string | null; dateText: string; bodyHtml: string }): string {
  const icon = `${appUrl}/email-icons/${emailIconSrc('chat', color.brandViolet)}`
  const rowBorder = `border-top:1px solid ${CARD_STYLE.rowBorder};`
  const titleHtml = title
    ? `<span style="font-size:${COMMENT_STYLE.titleSize}px;font-weight:${COMMENT_STYLE.titleWeight};color:${COMMENT_STYLE.titleColor};margin-left:4px;">${escHtml(title)}</span>`
    : ''
  return `<tr style="background:${color.white};">
      <td width="30" style="padding:11px 0 0 14px;vertical-align:top;${rowBorder}"><img src="${icon}" width="14" height="14" alt="" style="display:block;border:0;"></td>
      <td style="width:100%;padding:10px 8px 0 6px;vertical-align:top;${rowBorder}"><span style="font-size:${COMMENT_STYLE.nameSize}px;font-weight:${COMMENT_STYLE.nameWeight};color:${COMMENT_STYLE.nameColor};">${escHtml(name)}</span>${titleHtml}</td>
      <td align="right" style="padding:11px 14px 0 0;vertical-align:top;white-space:nowrap;${rowBorder}"><span style="font-size:${COMMENT_STYLE.dateSize}px;color:${COMMENT_STYLE.dateColor};">${escHtml(dateText)}</span></td>
    </tr>
    <tr style="background:${color.white};"><td colspan="3" style="padding:4px 14px 14px 34px;font-size:${COMMENT_STYLE.bodySize}px;color:${COMMENT_STYLE.bodyColor};line-height:${COMMENT_STYLE.bodyLineHeight};">${bodyHtml}</td></tr>`
}
