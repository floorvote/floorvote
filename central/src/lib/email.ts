import type { LsEnv } from '../types-legiscan'
import { htmlToText } from './htmlToText'
import { PRODUCT_NAME } from '../../../shared/brand'

export type ProviderName = 'resend' | 'cloudflare'
export type EmailMessage = { to: string[]; subject: string; html: string; text?: string; from?: string; replyTo?: string; headers?: Record<string, string> }
export type EmailSendResult = { ok: boolean; provider: ProviderName; error?: string }

const FALLBACK_EMAIL = 'notifications@example.com'
function resolveFrom(env: Pick<LsEnv, 'EMAIL_FROM'>): string {
  return `${PRODUCT_NAME} <${env.EMAIL_FROM ?? FALLBACK_EMAIL}>`
}
function resolveReplyTo(env: Pick<LsEnv, 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>): string {
  return env.EMAIL_REPLY_TO ?? env.EMAIL_FROM ?? FALLBACK_EMAIL
}

export interface CloudflareEmailBinding {
  send(message: { to: string | string[]; from: string; subject: string; html?: string; text?: string; replyTo?: string | string[]; headers?: Record<string, string> }): Promise<unknown>
}

// `text` is always resolved (derived from html when not supplied).
type ResolvedMessage = EmailMessage & { from: string; replyTo: string; text: string }
type SendEnv = Pick<LsEnv, 'RESEND_API_KEY' | 'EMAIL_PROVIDER' | 'EMAIL' | 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>

export function activeProvider(env: Pick<LsEnv, 'EMAIL_PROVIDER' | 'EMAIL'>): ProviderName {
  if (env.EMAIL_PROVIDER === 'cloudflare' && env.EMAIL) return 'cloudflare'
  return 'resend'
}

/** Send one message via the active provider. Applies From/Reply-To defaults. Never throws. */
export async function sendEmail(env: SendEnv, message: EmailMessage): Promise<EmailSendResult> {
  const msg: ResolvedMessage = {
    ...message,
    from: message.from ?? resolveFrom(env),
    replyTo: message.replyTo ?? resolveReplyTo(env),
    text: message.text ?? htmlToText(message.html),
  }
  if (activeProvider(env) === 'cloudflare') {
    try {
      await env.EMAIL!.send({ to: msg.to, from: msg.from, subject: msg.subject, html: msg.html, text: msg.text, replyTo: msg.replyTo, headers: msg.headers })
      return { ok: true, provider: 'cloudflare' }
    } catch (e: unknown) {
      // Binding throws a standard Error with a `.code` (e.g. E_RECIPIENT_SUPPRESSED).
      const m = e instanceof Error ? e.message : String(e)
      const code = (e as { code?: string })?.code
      const detail = code ? `${code}: ${m}` : m
      console.error('[email:cloudflare]', detail)
      return { ok: false, provider: 'cloudflare', error: detail }
    }
  }
  const body: Record<string, unknown> = { from: msg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, reply_to: msg.replyTo }
  if (msg.headers) body.headers = msg.headers
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error(`[email:resend] ${res.status} ${await res.text()}`)
    return { ok: false, provider: 'resend', error: String(res.status) }
  }
  return { ok: true, provider: 'resend' }
}
