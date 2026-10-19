/**
 * Email provider adapters: the only code that knows a transport.
 *
 * Each adapter sends one message and returns an `Attempt`. It never throws,
 * and it classifies its own failures: `permanent` means the address can't
 * receive mail (retrying later, or through the other provider, can't help),
 * and anything else is temporary. The purpose-level sender
 * (`shared/emailSender.ts`) decides what to do with the verdict; callers
 * should go through the sender, not these adapters.
 *
 * Shared by the API and central. No API or central types here: the env shape
 * below is the subset both Workers bind.
 */

export type ProviderName = 'resend' | 'cloudflare'

/** A fully resolved message, as a provider receives it. The sender fills From, Reply-To, and text. */
export type OutgoingEmail = {
  to: string[]
  from: string
  replyTo: string
  subject: string
  html: string
  text: string
  headers?: Record<string, string>
}

/** What a Resend response says about the account's quota, for the API's usage readout. */
export type ProviderUsage = { monthlyUsed: number | null; dailyUsed: number | null; throttled: boolean }

/** One try at one provider. */
export type Attempt =
  | { ok: true; provider: ProviderName; messageId?: string; usage?: ProviderUsage }
  | { ok: false; provider: ProviderName; error: string; permanent: boolean; usage?: ProviderUsage }

export interface EmailProvider {
  readonly name: ProviderName
  /** Send one message. Never throws: a failure comes back as `{ ok: false }`. */
  send(email: OutgoingEmail): Promise<Attempt>
}

// Minimal shape of the Cloudflare Email Service `[[send_email]]` binding.
// Defined here to avoid depending on an unstable @cloudflare/workers-types export.
export interface CloudflareEmailBinding {
  send(message: {
    to: string | string[]
    from: string
    subject: string
    html?: string
    text?: string
    replyTo?: string | string[]
    headers?: Record<string, string>
  }): Promise<unknown> // resolves to { messageId?: string }
}

export type EmailProviderEnv = {
  /** 'cloudflare' picks the binding first when it is bound. Anything else picks Resend. */
  EMAIL_PROVIDER?: string
  EMAIL?: CloudflareEmailBinding
  RESEND_API_KEY?: string
}

const RESEND_URL = 'https://api.resend.com/emails'

function readUsage(res: Response): ProviderUsage | undefined {
  const num = (v: string | null) => (v != null && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
  const monthlyUsed = num(res.headers.get('x-resend-monthly-quota'))
  const dailyUsed = num(res.headers.get('x-resend-daily-quota'))
  const throttled = res.status === 429
  if (monthlyUsed === null && dailyUsed === null && !throttled) return undefined
  return { monthlyUsed, dailyUsed, throttled }
}

/**
 * Resend over its HTTP API. Every Resend failure is temporary: its send API
 * doesn't report a suppressed recipient synchronously (it accepts the message
 * and reports the suppression later, by webhook), and the sender has already
 * rejected malformed addresses before calling a provider. A rejected key or an
 * unverified domain is this provider's problem, which the other provider can
 * route around.
 *
 * `fetchImpl` is for tests. Without it, the global `fetch` is read at send
 * time, so a test's `vi.stubGlobal('fetch', ...)` applies.
 */
export function resendProvider(apiKey: string | undefined, fetchImpl?: typeof fetch): EmailProvider {
  return {
    name: 'resend',
    async send(email) {
      const body: Record<string, unknown> = {
        from: email.from, to: email.to, subject: email.subject, html: email.html, text: email.text, reply_to: email.replyTo,
      }
      if (email.headers) body.headers = email.headers
      let res: Response
      try {
        res = await (fetchImpl ?? globalThis.fetch)(RESEND_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (err) {
        // A connection-level failure comes back as a failed attempt, not a
        // throw: a throw would skip fallback and counting.
        console.error('[email:resend]', err)
        return { ok: false, provider: 'resend', error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`, permanent: false }
      }
      const usage = readUsage(res)
      if (!res.ok) {
        console.error(`[email:resend] ${res.status} ${await res.text().catch(() => '')}`)
        return { ok: false, provider: 'resend', error: String(res.status), permanent: false, ...(usage && { usage }) }
      }
      const json = await res.json().catch(() => ({})) as { id?: string }
      return { ok: true, provider: 'resend', messageId: json.id, ...(usage && { usage }) }
    },
  }
}

/**
 * Error codes from the binding that mean the address can't receive mail. Only
 * a suppression qualifies: the address hard-bounced or reported spam.
 * E_RECIPIENT_NOT_ALLOWED is the binding's own allowlist, which Resend doesn't
 * share, and E_VALIDATION_ERROR or E_DELIVERY_FAILED can be about the message
 * or the moment as much as the address. Deliberately narrow: anything not
 * listed is treated as the provider failing, which errs toward falling back
 * and toward alerting.
 */
const CLOUDFLARE_PERMANENT_CODES = new Set(['E_RECIPIENT_SUPPRESSED'])

/** The Cloudflare Email Service `send_email` binding. */
export function cloudflareProvider(binding: CloudflareEmailBinding | undefined): EmailProvider {
  return {
    name: 'cloudflare',
    async send(email) {
      if (!binding) {
        console.error('[email:cloudflare] no EMAIL binding')
        return { ok: false, provider: 'cloudflare', error: 'EMAIL binding not configured', permanent: false }
      }
      try {
        const resp = await binding.send({
          to: email.to, from: email.from, subject: email.subject, html: email.html, text: email.text,
          replyTo: email.replyTo, headers: email.headers,
        }) as { messageId?: string } | undefined
        return { ok: true, provider: 'cloudflare', messageId: resp?.messageId }
      } catch (e: unknown) {
        // The binding throws a standard Error with a `.code` (E_RECIPIENT_SUPPRESSED,
        // E_RATE_LIMIT_EXCEEDED, ...). Keep the code in the error so a failure is diagnosable.
        const message = e instanceof Error ? e.message : String(e)
        const code = (e as { code?: unknown } | null)?.code
        const error = typeof code === 'string' && code ? `${code}: ${message}` : message
        console.error('[email:cloudflare]', error)
        return { ok: false, provider: 'cloudflare', error, permanent: typeof code === 'string' && CLOUDFLARE_PERMANENT_CODES.has(code) }
      }
    },
  }
}

/** The provider tried first: the binding when chosen and bound, else Resend (the fail-safe default). */
export function primaryProviderName(env: Pick<EmailProviderEnv, 'EMAIL_PROVIDER' | 'EMAIL'>): ProviderName {
  return env.EMAIL_PROVIDER === 'cloudflare' && env.EMAIL ? 'cloudflare' : 'resend'
}

/** The provider that is not `primary`, if it is configured. */
export function fallbackProviderName(env: Pick<EmailProviderEnv, 'RESEND_API_KEY' | 'EMAIL'>, primary: ProviderName): ProviderName | null {
  if (primary === 'cloudflare') return env.RESEND_API_KEY ? 'resend' : null
  return env.EMAIL ? 'cloudflare' : null
}

function providerFor(env: EmailProviderEnv, name: ProviderName): EmailProvider {
  return name === 'cloudflare' ? cloudflareProvider(env.EMAIL) : resendProvider(env.RESEND_API_KEY)
}

/**
 * The configured providers, primary first. The primary is always present
 * (Resend, even with no key, as the API has always behaved), and the second
 * only when it is configured.
 */
export function providersFromEnv(env: EmailProviderEnv): EmailProvider[] {
  const primary = primaryProviderName(env)
  const second = fallbackProviderName(env, primary)
  return second ? [providerFor(env, primary), providerFor(env, second)] : [providerFor(env, primary)]
}

/**
 * Only the providers that can actually send: `providersFromEnv` without a
 * Resend that has no key. Central uses this, so an unconfigured sender fails
 * fast instead of calling Resend with no credentials.
 */
export function configuredProviders(env: EmailProviderEnv): EmailProvider[] {
  return providersFromEnv(env).filter(p => p.name !== 'resend' || Boolean(env.RESEND_API_KEY))
}

/** Whether any provider can actually send: a Resend key, or the binding. */
export function hasConfiguredProvider(env: EmailProviderEnv): boolean {
  return configuredProviders(env).length > 0
}
