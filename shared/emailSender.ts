/**
 * The purpose-level email sender, shared by the API and central (#705).
 *
 * A caller names an email's purpose, and the sender decides everything else
 * from it: whether a temporary failure falls back to the other provider,
 * whether attempts count toward email health, the From address, and whether
 * demo mode suppresses it. It also rejects a malformed address before any
 * provider is called, for every purpose.
 *
 *     const sender = createSender(env, { recorder })   // the API passes a recorder; central doesn't
 *     const r = await sender.send({ purpose: 'sign-in', link: 'login', to: [email], subject, html, text })
 *     if (!r.ok && r.permanent) ...                   // the address can't receive mail
 *
 * `send` never throws. Its result says whether the message went out, which
 * provider sent it, and, on failure, whether the failure is permanent (the
 * address can't receive mail) or temporary (worth trying again later).
 *
 * Adding a purpose: add its message type to `PurposeMessage` and its rule to
 * `RULES`. Today: sign-in (tenant login, admin-sent login and invite links, the
 * invite queue), account (the email-change emails and the "this wasn't me"
 * report), and notification (mentions and replies). #708 to #710 move the rest.
 *
 * Tests pass in-memory providers through `SenderOptions.providers`; the real
 * adapters live in `./emailProviders`.
 */
import { htmlToText } from './htmlToText'
import { isValidEmail } from './email'
import { PRODUCT_NAME } from './brand'
import { providersFromEnv, type Attempt, type EmailProvider, type EmailProviderEnv, type OutgoingEmail, type ProviderName } from './emailProviders'

export type { Attempt, EmailProvider, OutgoingEmail, ProviderName } from './emailProviders'

export type Purpose = PurposeMessage['purpose']

/** What every purpose's message carries. From and Reply-To come from the purpose and env, never the caller. */
type BaseMessage = {
  to: string[]
  subject: string
  html: string
  /** Plain-text part. Derived from `html` when omitted. */
  text?: string
  headers?: Record<string, string>
}

/** One sign-in event (an `auth_events` row) the sender reports per attempt. */
export type SignInEvent = {
  event: 'email_sent' | 'email_bounced' | 'email_send_failed'
  /** Null when no provider was tried: an invalid address. */
  provider: ProviderName | null
  reason: string | null
  messageId: string | null
}

/**
 * A login or invite link. `recordEvent` is called once per attempt (and once,
 * with no provider, for an invalid address), so a send that fallback rescued
 * shows both halves. The API writes each to `auth_events`; central passes none.
 */
export type SignInMessage = BaseMessage & {
  purpose: 'sign-in'
  link: 'login' | 'invite'
  recordEvent?: (e: SignInEvent) => Promise<void>
}

/** An email-change email (the confirmation link, the notice to the old address) or the "this wasn't me" report. */
export type AccountMessage = BaseMessage & { purpose: 'account' }

/** A mention or reply email. A reply carries its thread and one-click mute headers in `headers`. */
export type NotificationMessage = BaseMessage & { purpose: 'notification' }

export type PurposeMessage = SignInMessage | AccountMessage | NotificationMessage

export type SendResult =
  | { ok: true; provider: ProviderName; messageId?: string; attempts: Attempt[] }
  /** Demo mode suppressed it. Not a failure: nothing should retry it. */
  | { ok: true; provider: null; skipped: 'demo-mode'; attempts: [] }
  /** `provider` is the last one tried, or null when none was (an invalid address, or no provider). */
  | { ok: false; provider: ProviderName | null; error: string; permanent: boolean; attempts: Attempt[] }

/** `sent` and `failed` count messages, not attempts. `skipped` counts demo-mode suppressions. */
export type BatchResult = { sent: number; failed: number; skipped: number; results: SendResult[] }

/**
 * Counts attempts toward email health. The sender calls it only for purposes
 * that count, once per send (or once per batch) with every attempt made, each
 * tagged with its provider. A permanent failure is about the address, not the
 * provider. The sender swallows anything it throws: a stats write must never
 * fail a send.
 */
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
  /** Omit to count nothing (central's case). */
  recorder?: HealthRecorder
  /** Providers in the order to try them. Defaults to `providersFromEnv(env)`. Tests pass in-memory ones. */
  providers?: EmailProvider[]
}

export interface EmailSender {
  send(message: PurposeMessage): Promise<SendResult>
  /** Several sends, with bounded concurrency. Each message is sent as `send` would; health is recorded once for the batch. */
  sendBatch(messages: PurposeMessage[]): Promise<BatchResult>
}

// Single fallback when no EMAIL_FROM is configured.
const FALLBACK_EMAIL = 'notifications@example.com'

/** Sender line, e.g. "FloorVote <notifications@example.com>", from EMAIL_FROM (falls back to example.com). */
export function resolveFrom(env: Pick<SenderEnv, 'EMAIL_FROM'>): string {
  return `${PRODUCT_NAME} <${env.EMAIL_FROM ?? FALLBACK_EMAIL}>`
}

/**
 * Sender line for bulk mail (daily digest, week-ahead). EMAIL_FROM_BULK, when
 * set, is a dedicated sending subdomain that keeps a spam complaint on a
 * digest from hurting sign-in deliverability. Falls back to EMAIL_FROM.
 */
export function resolveFromBulk(env: Pick<SenderEnv, 'EMAIL_FROM' | 'EMAIL_FROM_BULK'>): string {
  return `${PRODUCT_NAME} <${env.EMAIL_FROM_BULK ?? env.EMAIL_FROM ?? FALLBACK_EMAIL}>`
}

/** Reply-To, from EMAIL_REPLY_TO, else EMAIL_FROM, else the example.com fallback. */
export function resolveReplyTo(env: Pick<SenderEnv, 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>): string {
  return env.EMAIL_REPLY_TO ?? env.EMAIL_FROM ?? FALLBACK_EMAIL
}

type Rule<M> = {
  /** Retry a temporary failure once through the other provider. */
  fallback: boolean
  /** Report attempts to the health recorder. */
  counts: boolean
  from: 'default' | 'bulk'
  /** Whether demo mode suppresses this message. */
  suppressedInDemo: (m: M) => boolean
}

type Rules = { [P in Purpose]: Rule<Extract<PurposeMessage, { purpose: P }>> }

const RULES: Rules = {
  // Invites go to an address typed into a request, so on a demo they are how
  // an anonymous visitor could mail a stranger from the operator's real sender.
  // Login links go only to stored member addresses, and the operator's own way
  // into a demo arrives by one, so they always send. (The API's invite routes
  // already refuse demo writes. This is the second lock on that door.)
  'sign-in': { fallback: true, counts: true, from: 'default', suppressedInDemo: (m) => m.link === 'invite' },
  // The email-change emails and the "this wasn't me" report. A member waits on
  // them, so they fall back, and a demo instance never sends them.
  account: { fallback: true, counts: true, from: 'default', suppressedInDemo: () => true },
  // Mentions and replies. Same rule as account mail: a member is waiting on the
  // conversation, so a first-provider outage shouldn't drop it.
  notification: { fallback: true, counts: true, from: 'default', suppressedInDemo: () => true },
}

function ruleFor(message: PurposeMessage): Rule<PurposeMessage> {
  return RULES[message.purpose] as Rule<PurposeMessage>
}

/**
 * Max sends in flight at once in a batch. Bounds the burst so a large fan-out
 * doesn't trip provider rate limits, while still finishing well inside one
 * Worker invocation.
 */
const BATCH_CONCURRENCY = 8

async function attempt(provider: EmailProvider, email: OutgoingEmail): Promise<Attempt> {
  // Adapters never throw by contract. Guard anyway, so a broken adapter is a
  // temporary failure that falls back rather than an exception that skips
  // counting and events.
  try {
    return await provider.send(email)
  } catch (err) {
    console.error(`[email:${provider.name}] adapter threw`, err)
    return { ok: false, provider: provider.name, error: err instanceof Error ? err.message : String(err), permanent: false }
  }
}

function signInEvent(a: Attempt): SignInEvent {
  if (a.ok) return { event: 'email_sent', provider: a.provider, reason: null, messageId: a.messageId ?? null }
  return { event: a.permanent ? 'email_bounced' : 'email_send_failed', provider: a.provider, reason: a.error, messageId: null }
}

async function reportEvent(message: PurposeMessage, e: SignInEvent): Promise<void> {
  if (message.purpose !== 'sign-in' || !message.recordEvent) return
  try { await message.recordEvent(e) } catch (err) { console.error('[email] recording a sign-in event failed', err) }
}

async function record(recorder: HealthRecorder | undefined, attempts: Attempt[]): Promise<void> {
  if (!recorder || attempts.length === 0) return
  try { await recorder.record(attempts) } catch (err) { console.error('[email] recording send health failed', err) }
}

export function createSender(env: SenderEnv, opts: SenderOptions = {}): EmailSender {
  const providers = opts.providers ?? providersFromEnv(env)
  const demo = env.DEMO_MODE === 'true'

  function resolve(message: PurposeMessage, rule: Rule<PurposeMessage>): OutgoingEmail {
    return {
      to: message.to,
      from: rule.from === 'bulk' ? resolveFromBulk(env) : resolveFrom(env),
      replyTo: resolveReplyTo(env),
      subject: message.subject,
      html: message.html,
      text: message.text ?? htmlToText(message.html),
      ...(message.headers && { headers: message.headers }),
    }
  }

  /** Deliver one message, without recording health: `send` and `sendBatch` record. */
  async function deliver(message: PurposeMessage): Promise<SendResult> {
    const rule = ruleFor(message)
    if (demo && rule.suppressedInDemo(message)) {
      console.log(`[email] demo mode: suppressing a ${message.purpose} email`)
      return { ok: true, provider: null, skipped: 'demo-mode', attempts: [] }
    }

    // An address that fails the shared check is never sent. Neither provider
    // can deliver it, so sending would only burn a retry on each provider and
    // count as provider failures toward the outage alert.
    const invalid = message.to.length === 0 ? ['(no recipients)'] : message.to.filter(a => !isValidEmail(a))
    if (invalid.length > 0) {
      await reportEvent(message, { event: 'email_send_failed', provider: null, reason: 'invalid recipient address; not sent', messageId: null })
      return { ok: false, provider: null, error: `Invalid recipient address: ${invalid.join(', ')}`, permanent: true, attempts: [] }
    }

    const [first, second] = providers
    if (!first) return { ok: false, provider: null, error: 'no email provider configured', permanent: false, attempts: [] }

    const email = resolve(message, rule)
    const attempts = [await attempt(first, email)]
    // One retry, on the other provider, and only for a temporary failure: a
    // permanent one is about the address, and retrying it would only hurt the
    // second provider's reputation too.
    const head = attempts[0]
    if (!head.ok && !head.permanent && rule.fallback && second) {
      console.warn(`[email] ${first.name} failed (${head.error}); retrying via ${second.name}`)
      attempts.push(await attempt(second, email))
    }
    for (const a of attempts) await reportEvent(message, signInEvent(a))

    const last = attempts[attempts.length - 1]
    return last.ok
      ? { ok: true, provider: last.provider, messageId: last.messageId, attempts }
      : { ok: false, provider: last.provider, error: last.error, permanent: last.permanent, attempts }
  }

  return {
    async send(message) {
      const result = await deliver(message)
      if (ruleFor(message).counts) await record(opts.recorder, result.attempts)
      return result
    },

    async sendBatch(messages) {
      const results: SendResult[] = []
      for (let i = 0; i < messages.length; i += BATCH_CONCURRENCY) {
        results.push(...await Promise.all(messages.slice(i, i + BATCH_CONCURRENCY).map(deliver)))
      }
      // One recorder call for the run: a 650-recipient batch would otherwise
      // cost 650 writes.
      const counted = results.flatMap((r, i) => (ruleFor(messages[i]).counts ? r.attempts : []))
      await record(opts.recorder, counted)
      const skipped = results.filter(r => r.ok && r.provider === null).length
      const sent = results.filter(r => r.ok && r.provider !== null).length
      return { sent, failed: results.length - sent - skipped, skipped, results }
    },
  }
}
