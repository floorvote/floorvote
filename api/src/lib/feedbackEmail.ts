import { renderEmailShell } from './emailShell'
import { color, fontSize } from '../../../shared/tokens'

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The email a member's feedback becomes. It goes to the operator, so the route
 * sends it with the operator purpose: it falls back, is never counted toward
 * email health, and sends on a demo too.
 */
export function renderFeedbackEmail(input: {
  fromEmail: string
  message: string
  pageUrl?: string
  appUrl: string
  /** The org's display name, when it has one. */
  assocName?: string
}): { subject: string; html: string } {
  const { fromEmail, message, pageUrl } = input
  const html = renderEmailShell({
    instanceName: input.assocName ?? '',
    appUrl: input.appUrl,
    signalHtml: 'New feedback',
    bodyHtml: `
        <p style="margin:0 0 8px;font-size:${fontSize.sm}px;color:${color.textMuted};">From: ${escHtml(fromEmail)}</p>
        ${pageUrl ? `<p style="margin:0 0 16px;font-size:${fontSize.sm}px;color:${color.textMuted};">Page: ${escHtml(pageUrl)}</p>` : ''}
        <p style="margin:0;font-size:${fontSize.base}px;line-height:1.6;color:${color.textSlate};white-space:pre-wrap;">${escHtml(message)}</p>`,
    footerHtml: '',
  })
  return { subject: `Feedback from ${fromEmail}`, html }
}
