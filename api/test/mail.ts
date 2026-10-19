import { vi } from 'vitest'
import { fakeSender } from '../../shared/emailTestKit'
import type { SignInMessage } from '../../shared/emailSender'

/**
 * The one fake for tests of code that sends email (#711). It stands in for the
 * shared sender, so a caller's test sees what it handed over (each message with
 * its purpose) and chooses what comes back, without caring how a provider fails.
 * The sender's own rules are tested against in-memory providers in
 * shared/emailSender.test.ts, and the API's wiring of it (the health recorder,
 * sign-in events) in the tests that run a real sender.
 *
 * Use it in a test file by replacing `senderFor` in the email module. Callers
 * reach the sender through that export, so the replacement is all it takes:
 *
 *     vi.mock('../../src/lib/email', async (importOriginal) =>
 *       (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))
 *     import { mail, resetMail } from '../mail'
 *     beforeEach(resetMail)
 *
 *     expect(mail.sent().map(m => m.purpose)).toEqual(['bulk', 'bulk'])
 *     mail.sendBatch.mockResolvedValue({ sent: 0, failed: 2, skipped: 0, results: [] })
 *
 * One fake per test file: vitest gives each file its own module registry.
 */
export const mail = fakeSender()

/** Every call to the API's `senderFor`, so a test can check what a caller passed (the env, and the db only when the purpose counts). */
export const senderFor = vi.fn((_env: unknown, _db?: unknown) => mail)

/** The email module with `senderFor` replaced by the fake. Everything else in it stays real. */
export function withFakeSender<T extends object>(actual: T): T & { senderFor: typeof senderFor } {
  return { ...actual, senderFor }
}

/** Forget what the fake recorded and go back to delivering everything. Call it in `beforeEach`. */
export function resetMail(): void {
  mail.reset()
  senderFor.mockClear()
}

/**
 * An ExecutionContext that remembers what a route handed to `waitUntil`, so a
 * test can wait for the background send before it looks at what was sent. Pass
 * `ctx` as the fourth argument of `app.request`, then `await settle()`.
 */
export function backgroundWork() {
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {} } as unknown as ExecutionContext
  return { ctx, settle: () => Promise.all(pending) }
}

/** The messages of the most recent `sendBatch`, or undefined when there was none. */
export const lastBatch = () => mail.sendBatch.mock.calls.at(-1)?.[0]

/** The sign-in messages handed to the fake, in order. */
export const signInSent = (): SignInMessage[] => mail.sent().filter((m): m is SignInMessage => m.purpose === 'sign-in')

/** The link a sign-in message carries: the first URL in its text part. */
export function linkIn(message: { text?: string }): string {
  const url = message.text?.match(/https?:\/\/\S+/)?.[0]
  if (!url) throw new Error('no link in the message text')
  return url
}
