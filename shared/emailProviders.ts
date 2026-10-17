export type ProviderName = 'resend' | 'cloudflare'

export type OutgoingEmail = {
  to: string[]
  from: string
  replyTo: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
}

export type ProviderUsage = { monthlyUsed: number | null; dailyUsed: number | null; throttled: boolean }

export type Attempt =
  | { ok: true; provider: ProviderName; messageId?: string; usage?: ProviderUsage }
  | { ok: false; provider: ProviderName; error: string; permanent: boolean; usage?: ProviderUsage }

export interface EmailProvider {
  readonly name: ProviderName
  send(email: OutgoingEmail): Promise<Attempt>
}

export interface CloudflareEmailBinding {
  send(message: {
    to: string | string[]
    from: string
    subject: string
    html?: string
    text?: string
    replyTo?: string | string[]
    headers?: Record<string, string>
  }): Promise<{ messageId?: string } | unknown>
}

export type EmailProviderEnv = {
  EMAIL_PROVIDER?: string
  EMAIL?: CloudflareEmailBinding
  RESEND_API_KEY?: string
}

export function resendProvider(_apiKey: string | undefined, _fetchImpl?: typeof fetch): EmailProvider {
  return { name: 'resend', send: async () => ({ ok: false, provider: 'resend', error: 'stub', permanent: false }) }
}

export function cloudflareProvider(_binding: CloudflareEmailBinding | undefined): EmailProvider {
  return { name: 'cloudflare', send: async () => ({ ok: false, provider: 'cloudflare', error: 'stub', permanent: false }) }
}

export function primaryProviderName(_env: Pick<EmailProviderEnv, 'EMAIL_PROVIDER' | 'EMAIL'>): ProviderName {
  return 'resend'
}

export function fallbackProviderName(_env: Pick<EmailProviderEnv, 'RESEND_API_KEY' | 'EMAIL'>, _primary: ProviderName): ProviderName | null {
  return null
}

export function providersFromEnv(_env: EmailProviderEnv): EmailProvider[] {
  return []
}
