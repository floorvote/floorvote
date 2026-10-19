import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { mail, senderFor, resetMail } from '../mail'

// The seam between the two bulk emails and the sender: what they hand it, and
// what they do with its answer. The sender itself is covered by
// shared/emailSender.test.ts and the end-to-end file bulkEmailSend.test.ts.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)
const stamp = async (key: string) => (await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, key)).get())?.value
const batch = (sent: number, failed: number, skipped = 0) => ({ sent, failed, skipped, results: [] })

beforeEach(async () => {
  await resetDb(); await applyMigrations()
  resetMail()
  mail.sendBatch.mockResolvedValue(batch(1, 0))
})

async function seedDigest(recipients: string[]) {
  const db = getDb(env.DB)
  await db.insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
  for (const email of recipients) await seedSession(await seedUser({ email }))
  const billId = await seedBill({ billNumber: 'H 1', state: 'RI', session: '2026', priority: 'high' })
  await db.insert(feedEvents).values({ id: crypto.randomUUID(), type: 'priority_set' as any, billId, userId: 'system', metadata: JSON.stringify({ priority: 'high' }) })
}

async function seedWeekAhead(recipients: string[]) {
  const db = getDb(env.DB)
  await db.insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: String(new Date().getUTCDay()) } } }) })
  for (const email of recipients) await seedSession(await seedUser({ email }))
  const bill = await seedBill({ billNumber: 'HB 100', state: 'DC', priority: 'high' })
  await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(2), description: 'Public Hearing on HB 100' })
}

// `from` is not part of a message: the purpose decides it. Typed so a test can say it is absent.
const sentMessages = () => mail.sent().map(m => m as typeof m & { from?: string })

describe('the digest', () => {
  it('sends one bulk message per recipient, with the unsubscribe header, through the API sender with the db', async () => {
    await seedDigest(['a@example.com', 'b@example.com'])
    const db = getDb(env.DB)
    await runDigest(env as any, db)
    expect(senderFor).toHaveBeenCalledWith(env, db)
    expect(mail.sendBatch).toHaveBeenCalledTimes(1)
    const messages = sentMessages()
    expect(messages.map(m => m.to)).toEqual(expect.arrayContaining([['a@example.com'], ['b@example.com']]))
    expect(messages).toHaveLength(2)
    for (const m of messages) {
      expect(m.purpose).toBe('bulk')
      expect(m.headers?.['List-Unsubscribe']).toContain('/profile#setting-email-digest')
      expect(m.subject).toBeTruthy()
      expect(m.html).toContain('H 1')
      // The From is the purpose's to decide, never the caller's.
      expect(m.from).toBeUndefined()
    }
  })

  it('returns the batch\'s sent and failed counts, and counts a demo suppression as neither', async () => {
    await seedDigest(['a@example.com', 'b@example.com', 'c@example.com'])
    mail.sendBatch.mockResolvedValue(batch(1, 1, 1))
    expect(await runDigest(env as any, getDb(env.DB))).toEqual({ ok: true, recipients: 3, sent: 1, failed: 1 })
  })

  it('stamps "last sent" whatever the batch returned', async () => {
    await seedDigest(['a@example.com'])
    mail.sendBatch.mockResolvedValue(batch(0, 1))
    await runDigest(env as any, getDb(env.DB))
    expect(mail.sendBatch).toHaveBeenCalledTimes(1)
    expect(await stamp('last_digest_at')).toBeTruthy()
  })

  it('does not ask the sender for anything when there is nothing to send', async () => {
    await seedDigest(['a@example.com'])
    await getDb(env.DB).delete(feedEvents)
    expect(await runDigest(env as any, getDb(env.DB))).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
    expect(mail.sendBatch).not.toHaveBeenCalled()
  })
})

describe('the week-ahead email', () => {
  it('sends one bulk message per recipient, with the unsubscribe header and the same body, through the API sender with the db', async () => {
    await seedWeekAhead(['a@example.com', 'b@example.com'])
    const db = getDb(env.DB)
    await runWeekAhead(env as any, db)
    expect(senderFor).toHaveBeenCalledWith(env, db)
    expect(mail.sendBatch).toHaveBeenCalledTimes(1)
    const messages = sentMessages()
    expect(messages).toHaveLength(2)
    expect(messages.map(m => m.to)).toEqual(expect.arrayContaining([['a@example.com'], ['b@example.com']]))
    expect(new Set(messages.map(m => m.html)).size).toBe(1)
    for (const m of messages) {
      expect(m.purpose).toBe('bulk')
      expect(m.headers?.['List-Unsubscribe']).toContain('/profile#setting-week-ahead')
      expect(m.subject).toMatch(/Your week ahead/)
      expect(m.html).toContain('Public Hearing on HB 100')
      expect(m.from).toBeUndefined()
    }
  })

  it('stamps "last sent" whatever the batch returned', async () => {
    await seedWeekAhead(['a@example.com'])
    mail.sendBatch.mockResolvedValue(batch(0, 1))
    await runWeekAhead(env as any, getDb(env.DB))
    expect(mail.sendBatch).toHaveBeenCalledTimes(1)
    expect(await stamp('last_week_ahead_at')).toBeTruthy()
  })

  it('does not ask the sender for anything when there are no events', async () => {
    await seedWeekAhead(['a@example.com'])
    await getDb(env.DB).delete((await import('../../src/db/schema')).calendarEvents)
    await runWeekAhead(env as any, getDb(env.DB))
    expect(mail.sendBatch).not.toHaveBeenCalled()
  })
})
