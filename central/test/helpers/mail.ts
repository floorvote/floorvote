import { vi } from 'vitest'

/**
 * Fake providers for central's email callers (sign-in link, ops alerts). The
 * transports themselves are covered by shared/emailProviders.test.ts and the
 * sender's rules by shared/emailSender.test.ts; these tests only need to drive
 * the real sender through each provider's outcomes.
 */

export type BindingMessage = { to: string | string[]; from: string; subject: string; html?: string; text?: string; replyTo?: string | string[] }

export type BindingMode = 'ok' | 'down' | 'suppressed' | 'throw-sync'

/** A stand-in for the `send_email` binding. `sent` records every message it was handed, down or not. */
export function fakeBinding(mode: BindingMode = 'ok') {
  const sent: BindingMessage[] = []
  const binding = {
    send(m: BindingMessage) {
      sent.push(m)
      if (mode === 'throw-sync') throw new Error('binding threw synchronously')
      if (mode === 'down') return Promise.reject(Object.assign(new Error('binding is down'), { code: 'E_INTERNAL_SERVER_ERROR' }))
      if (mode === 'suppressed') return Promise.reject(Object.assign(new Error('recipient suppressed'), { code: 'E_RECIPIENT_SUPPRESSED' }))
      return Promise.resolve({ messageId: `cf-${sent.length}` })
    },
  }
  return { sent, binding }
}

export type ResendMode = 'ok' | 'down' | 'throw'

export type ResendCall = { url: string; auth: string | undefined; body: { from: string; to: string[]; subject: string; html: string; text: string; reply_to: string } }

/** Stubs `fetch` as Resend's API. Restore with `vi.restoreAllMocks()`. */
export function stubResend(mode: ResendMode = 'ok') {
  const calls: ResendCall[] = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: String(url),
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body: JSON.parse(String(init?.body)),
    })
    if (mode === 'throw') throw new TypeError('network unreachable')
    if (mode === 'down') return new Response('upstream error', { status: 503 })
    return new Response(JSON.stringify({ id: `re-${calls.length}` }), { status: 200 })
  })
  return { calls, spy }
}

export const RESEND_KEY = 'test-resend-key'

/** Both providers configured, the binding first. */
export const bothBindingFirst = (binding: unknown) => ({ EMAIL_PROVIDER: 'cloudflare', EMAIL: binding, RESEND_API_KEY: RESEND_KEY })
/** Both providers configured, Resend first. */
export const bothResendFirst = (binding: unknown) => ({ EMAIL: binding, RESEND_API_KEY: RESEND_KEY })
