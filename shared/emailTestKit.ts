/**
 * The one set of email fakes every test shares (#711). Test code only: no
 * production module imports it.
 *
 * Pick the fake that matches the seam under test:
 *
 *  - `fakeSender`: a caller's tests (a route, a job, the queue). It stands in
 *    for the whole sender, records each message with its purpose, and answers
 *    whatever the test chooses. The sender's own rules are not under test here.
 *  - `memoryProvider` and `memoryRecorder`: the sender's tests. They go into
 *    `createSender` through `SenderOptions`, so a purpose's fallback, counting,
 *    From, and demo-mode rules run for real with no network.
 *  - `fakeBinding` and `stubResend`: the tests that run a real adapter, or
 *    a caller end to end through the real sender. They fake the transport
 *    itself: the `send_email` binding, and Resend's HTTP API over `fetch`.
 *    `stubResend` stands where the API's `stubFetch` would (AGENTS.md Rule 12),
 *    because central has no `stubFetch` and the two suites share this kit.
 */
import { vi } from 'vitest'
import type { Attempt, EmailProvider, OutgoingEmail, ProviderName } from './emailProviders'
import type { BatchResult, EmailSender, HealthRecorder, PurposeMessage, SendResult } from './emailSender'

export type Outcome = 'ok' | 'temporary' | 'permanent' | 'throw'

/**
 * An in-memory provider. `outcomes` is one answer for every send, or a list
 * walked in order with the last one repeated. `throw` is a broken adapter.
 */
export function memoryProvider(name: ProviderName, outcomes: Outcome[] | Outcome = 'ok') {
  const sent: OutgoingEmail[] = []
  let i = 0
  const provider: EmailProvider & { sent: OutgoingEmail[] } = {
    name,
    sent,
    async send(email) {
      sent.push(email)
      const outcome = Array.isArray(outcomes) ? outcomes[Math.min(i++, outcomes.length - 1)] : outcomes
      if (outcome === 'throw') throw new Error(`${name} adapter blew up`)
      if (outcome === 'ok') return { ok: true, provider: name, messageId: `${name}-${sent.length}` }
      return { ok: false, provider: name, error: outcome === 'permanent' ? 'E_RECIPIENT_SUPPRESSED: gone' : 'outage', permanent: outcome === 'permanent' }
    },
  }
  return provider
}

/** A health recorder that keeps each call's attempts. */
export function memoryRecorder() {
  const calls: Attempt[][] = []
  const recorder: HealthRecorder & { calls: Attempt[][] } = { calls, async record(attempts) { calls.push(attempts) } }
  return recorder
}

const DELIVERED: SendResult = { ok: true, provider: 'resend', attempts: [] }
const deliveredBatch = (messages: PurposeMessage[]): BatchResult => ({ sent: messages.length, failed: 0, skipped: 0, results: [] })

/**
 * A stand-in for the whole sender, for a caller's tests. By default every send
 * is delivered. `send` and `sendBatch` are `vi.fn`s: a test picks the answer
 * with `mockResolvedValue` or `mockRejectedValue`, and reads what it was handed
 * from `sent()`, which lists every message in the order it was handed over,
 * each with its purpose.
 */
export function fakeSender() {
  const send = vi.fn<(message: PurposeMessage) => Promise<SendResult>>(async () => DELIVERED)
  const sendBatch = vi.fn<(messages: PurposeMessage[]) => Promise<BatchResult>>(async (messages) => deliveredBatch(messages))

  const fake = {
    send,
    sendBatch,
    /** Every message handed to `send` or `sendBatch`, in order. */
    sent(): PurposeMessage[] {
      const handed = [
        ...send.mock.calls.map((c, i) => ({ order: send.mock.invocationCallOrder[i], messages: [c[0]] })),
        ...sendBatch.mock.calls.map((c, i) => ({ order: sendBatch.mock.invocationCallOrder[i], messages: c[0] })),
      ]
      return handed.sort((a, b) => a.order - b.order).flatMap(h => h.messages)
    },
    /** Forget what was recorded and go back to delivering everything. */
    reset() {
      send.mockReset().mockImplementation(async () => DELIVERED)
      sendBatch.mockReset().mockImplementation(async (messages) => deliveredBatch(messages))
    },
  }
  return fake satisfies EmailSender & { sent(): PurposeMessage[]; reset(): void }
}

export type BindingMessage = { to: string | string[]; from: string; subject: string; html?: string; text?: string; replyTo?: string | string[]; headers?: Record<string, string> }

export type BindingMode = 'ok' | 'down' | 'suppressed' | 'throw-sync'

/** Which mode the binding answers in: one for every send, a list walked in order (the last repeated), or a function of the message and the call number (from 1). */
export type BindingOutcomes = BindingMode | BindingMode[] | ((message: BindingMessage, call: number) => BindingMode)

/**
 * A stand-in for the `send_email` binding. `sent` records every message it was
 * handed, down or not, and `delivered` only those it accepted. A down binding
 * rejects with `failure`, or with a generic outage when a test doesn't care
 * what it says. A test that needs a different answer per call passes a list of
 * modes, as `memoryProvider` takes a list of outcomes, or a function that picks
 * the mode from the message (a different answer per recipient) and the call number.
 */
export function fakeBinding(outcomes: BindingOutcomes = 'ok', failure?: { message: string; code: string }) {
  const sent: BindingMessage[] = []
  const delivered: BindingMessage[] = []
  const modeFor = (m: BindingMessage, call: number): BindingMode =>
    typeof outcomes === 'function' ? outcomes(m, call)
      : Array.isArray(outcomes) ? outcomes[Math.min(call - 1, outcomes.length - 1)]
        : outcomes
  const binding = {
    send(m: BindingMessage) {
      sent.push(m)
      const mode = modeFor(m, sent.length)
      if (mode === 'throw-sync') throw new Error('binding threw synchronously')
      if (mode === 'down') {
        const { message, code } = failure ?? { message: 'binding is down', code: 'E_INTERNAL_SERVER_ERROR' }
        return Promise.reject(Object.assign(new Error(message), { code }))
      }
      if (mode === 'suppressed') return Promise.reject(Object.assign(new Error('recipient suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' }))
      delivered.push(m)
      return Promise.resolve({ messageId: `cf-${delivered.length}` })
    },
  }
  return { sent, delivered, binding }
}

export type ResendMode = 'ok' | 'down' | 'throw'

export type ResendCall = { url: string; auth: string | undefined; body: { from: string; to: string[]; subject: string; html: string; text: string; reply_to: string } }

/**
 * Stubs `fetch` as Resend's API. A down Resend answers 503 unless a test gives
 * it another status or body, and a test can add response headers (Resend's quota
 * headers, say) to either answer. Restore with `vi.restoreAllMocks()`.
 */
export function stubResend(mode: ResendMode = 'ok', answer?: { status?: number; body?: string; headers?: Record<string, string> }) {
  const calls: ResendCall[] = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: JSON.parse(String(init?.body)),
    })
    if (mode === 'throw') throw new TypeError('network unreachable')
    if (mode === 'down') return new Response(answer?.body ?? 'upstream error', { status: answer?.status ?? 503, headers: answer?.headers })
    return new Response(JSON.stringify({ id: `re-${calls.length}` }), { status: 200, headers: answer?.headers })
  })
  return { calls, spy }
}

/** A made-up key, low-entropy on purpose: secret scanners read branches. */
export const RESEND_KEY = 'test-resend-key'

/** Both providers configured, the binding first. */
export const bothBindingFirst = (binding: unknown) => ({ EMAIL_PROVIDER: 'cloudflare', EMAIL: binding, RESEND_API_KEY: RESEND_KEY })
/** Both providers configured, Resend first. */
export const bothResendFirst = (binding: unknown) => ({ EMAIL: binding, RESEND_API_KEY: RESEND_KEY })
