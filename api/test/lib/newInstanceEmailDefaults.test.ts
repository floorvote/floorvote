import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { DEFAULT_MODULES, digestTeamChoice, newBillsDefault, weekAheadSentPhrase } from '../../../shared/modules'
import { mail, resetMail } from '../mail'

// A new instance, one that never saved its modules, starts with the team's email settings in DEFAULT_MODULES: the
// email digest with priority bills and saved views, every day, with new bills off for members by default, and the
// week ahead email on Fridays. Comment emails are on by default already (lib/mentions.ts).

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const db = () => getDb(env.DB)
const hourAgo = () => new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ')

describe('the email settings a new instance starts with', () => {
  it('are the digest with priority bills and saved views, new bills off for members, and the week ahead email on Fridays', () => {
    expect(digestTeamChoice(DEFAULT_MODULES)).toBe('on')
    expect(newBillsDefault(DEFAULT_MODULES)).toBe(false)
    expect(weekAheadSentPhrase(DEFAULT_MODULES)).toBe('every Friday morning')
  })
})

describe('a new instance with no saved modules', () => {
  beforeEach(async () => {
    await clearDb()
    resetMail()
    mail.sendBatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
    expect(await db().select().from(associationConfig).where(eq(associationConfig.key, 'modules')).get()).toBeUndefined()
  })

  it('sends the email digest: a member gets priority bills without new bills, and an admin gets both', async () => {
    for (const [email, role] of [['member@example.com', 'member'], ['admin@example.com', 'admin']] as const) {
      await seedSession(await seedUser({ email, role }))
    }
    const pri = await seedBill({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
    await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as never, billId: pri, userId: 'system', metadata: JSON.stringify({ position: 'Support' }) })
    await seedBill({ billNumber: 'NM 7', state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', relevanceScore: 7, newMatchAt: hourAgo() })

    const result = await runDigest(env as never, db())

    expect(result.skipped).toBeUndefined()
    const sent = mail.sent() as Array<{ to: string[]; subject: string }>
    const subject = (to: string) => sent.filter(s => s.to[0] === to).map(s => s.subject)
    expect(subject('member@example.com')).toEqual(['Your daily digest: 1 updated bill'])
    expect(subject('admin@example.com')).toEqual(['Your daily digest: 1 updated bill, 1 new match'])
  })

  it('sends the week ahead email on Fridays', async () => {
    const friday = new Date().getUTCDay() === 5
    expect(await runWeekAhead(env as never, db())).toEqual(friday ? undefined : { skipped: 'not-today' })
  })

  it('sends neither once it saves modules without them', async () => {
    await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'upcoming-hearings': true }) })
    expect(await runDigest(env as never, db())).toMatchObject({ skipped: 'off' })
    expect(await runWeekAhead(env as never, db())).toEqual({ skipped: 'off' })
  })
})
