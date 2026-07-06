import { sendEmail } from './email'
import type { LsEnv } from '../types-legiscan'
import { PRODUCT_NAME } from '../../../shared/brand'

export async function sendAdminMagicLink(
  to: string,
  magicLinkUrl: string,
  env: Pick<LsEnv, 'RESEND_API_KEY' | 'EMAIL_PROVIDER' | 'EMAIL'>,
): Promise<void> {
  const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; color: #0f172a;">
        <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #334155;">
          You requested a sign-in link for ${PRODUCT_NAME} central admin console. Click the button below. This link expires in 30 minutes and can only be used once.
        </p>
        <p style="margin: 0 0 32px;">
          <a href="${magicLinkUrl}" style="display: inline-block; background: #1e3a5f; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 6px;">
            Sign in to central admin
          </a>
        </p>
        <p style="margin: 0; font-size: 13px; color: #94a3b8; line-height: 1.5;">
          If you didn't expect this email, you can safely ignore it.
        </p>
      </div>
    `
  // Hand-written plain-text part (auto-derive would say "click the button" —
  // wrong with no button). Keep the URL prominent for text-only clients.
  const text = `You requested a sign-in link for ${PRODUCT_NAME} central admin console. Open this link to sign in:\n\n${magicLinkUrl}\n\nThis link expires in 30 minutes and can only be used once. If you didn't expect this email, you can safely ignore it.`
  const r = await sendEmail(env, { to: [to], subject: `Your admin sign-in link for ${PRODUCT_NAME}`, html, text })
  if (!r.ok) throw new Error(`Email send failed (${r.provider}): ${r.error}`)
}
