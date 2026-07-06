import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
import { WORDMARK } from './email'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface EmailShellInput {
  /** Association display name, shown under the wordmark (desktop-sidebar parity).
   *  REQUIRED so no email type can silently ship without instance branding —
   *  the #1 source of past drift. Pass the resolved association name. */
  instanceName: string
  /** The type-signal sentence (may contain <strong>). Required. */
  signalHtml: string
  /** Small date/period line under the sentence. Omit to hide the row. */
  dateLabel?: string
  /** Card / content HTML, rendered directly on the gray backdrop. */
  bodyHtml: string
  /** Optional CTA block (e.g. the magic-link button), placed after the body. */
  ctaHtml?: string
  /** Footer inner HTML (links). Rendered centered with a top border. */
  footerHtml: string
}

/**
 * The single email skeleton: gray (surfaceSubtle) backdrop, 560px column,
 * 32px outer padding, table-based for client compatibility. Masthead =
 * wordmark + instance name + type sentence + optional date, all on the gray.
 * Cards live in bodyHtml and carry their own white border/shadow.
 */
export function renderEmailShell(input: EmailShellInput): string {
  const instanceLine = input.instanceName
    ? `<p style="margin:0;font-size:${fontSize.sm}px;font-weight:${fontWeight.semibold};color:${color.textSecondary};">${esc(input.instanceName)}</p>`
    : ''
  const dateLine = input.dateLabel
    ? `<p class="email-date" style="margin:2px 0 0;font-size:${fontSize.sm}px;color:${color.textMuted};">${esc(input.dateLabel)}</p>`
    : ''
  const cta = input.ctaHtml ? `<div style="margin-top:18px;">${input.ctaHtml}</div>` : ''
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${color.surfaceSubtle};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${color.surfaceSubtle};padding:32px 0;">
    <tbody><tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tbody>
          <tr><td style="padding:0 20px 18px;">
            ${WORDMARK}
            ${instanceLine}
            <p style="margin:18px 0 0;font-size:${fontSize.xl}px;font-weight:${fontWeight.bold};color:${color.textPrimary};line-height:1.35;">${input.signalHtml}</p>
            ${dateLine}
          </td></tr>
          <tr><td style="padding:6px 20px 28px;">
            ${input.bodyHtml}
            ${cta}
          </td></tr>
          <tr><td style="padding:22px 20px 4px;border-top:1px solid ${color.borderDefault};text-align:center;">
            ${input.footerHtml}
          </td></tr>
        </tbody>
      </table>
    </td></tr></tbody>
  </table>
</body>
</html>`
}

/** Single navy CTA button used across emails. */
export function emailButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${color.accentBlue};color:${color.white};text-decoration:none;font-size:${fontSize.base}px;font-weight:${fontWeight.semibold};padding:12px 24px;border-radius:${radius.md}px;">${label}</a>`
}

/** Single footer link style shared across emails. */
export function emailFooterLink(href: string, label: string): string {
  return `<a href="${href}" style="font-size:${fontSize.sm}px;color:${color.textMuted};text-decoration:underline;">${label}</a>`
}

/**
 * The one date-range formatter for all emails. Single en-dash style WITH spaces
 * ("Jun 3 – Jun 10"); collapses to a single label when start === end. Every email
 * that shows a date range MUST use this — don't inline range strings (that's how
 * the spacing drifted before). `first`/`last` are already-formatted day labels.
 */
export function formatDateRange(first: string, last: string): string {
  return first === last ? first : `${first} – ${last}`
}
