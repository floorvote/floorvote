import type { Attempt, EmailProvider, EmailProviderEnv, ProviderName } from './emailProviders'

export type Purpose = 'sign-in'

type BaseMessage = {
  to: string[]
  subject: string
  html: string
  text?: string
  headers?: Record<string, string>
}

export type SignInEvent = {
  event: 'email_sent' | 'email_bounced' | 'email_send_failed'
  provider: ProviderName | null
  reason: string | null
  messageId: string | null
}

export type SignInMessage = BaseMessage & {
  purpose: 'sign-in'
  link: 'login' | 'invite'
  recordEvent?: (e: SignInEvent) => Promise<void>
}

export type PurposeMessage = SignInMessage

export type SendResult =
  | { ok: true; provider: ProviderName; messageId?: string; attempts: Attempt[] }
  | { ok: true; provider: null; skipped: 'demo-mode'; attempts: [] }
  | { ok: false; provider: ProviderName | null; error: string; permanent: boolean; attempts: Attempt[] }

export type BatchResult = { sent: number; failed: number; skipped: number; results: SendResult[] }

export interface HealthRecorder {
  record(attempts: Attempt[]): Promise<void>
}

export type SenderEnv = EmailProviderEnv & {
  EMAIL_FROM?: string
  EMAIL_FROM_BULK?: string
  EMAIL_REPLY_TO?: string
  DEMO_MODE?: string
}

export type SenderOptions = {
  recorder?: HealthRecorder
  providers?: EmailProvider[]
}

export interface EmailSender {
  send(message: PurposeMessage): Promise<SendResult>
  sendBatch(messages: PurposeMessage[]): Promise<BatchResult>
}

export function resolveFrom(_env: Pick<SenderEnv, 'EMAIL_FROM'>): string { return '' }
export function resolveFromBulk(_env: Pick<SenderEnv, 'EMAIL_FROM' | 'EMAIL_FROM_BULK'>): string { return '' }
export function resolveReplyTo(_env: Pick<SenderEnv, 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>): string { return '' }

export function createSender(_env: SenderEnv, _opts: SenderOptions = {}): EmailSender {
  const fail: SendResult = { ok: false, provider: null, error: 'stub', permanent: false, attempts: [] }
  return {
    send: async () => fail,
    sendBatch: async () => ({ sent: 0, failed: 0, skipped: 0, results: [] }),
  }
}
