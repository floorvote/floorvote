import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents } from '../../src/db/schema'
import { stubResend } from '../../../shared/emailTestKit'
import { runDigest } from '../../src/lib/digest'

// The no-priority updates row (#919) is the feed's, never the digest's: the
// digest is about the team's priorities, so neither the row nor the updates it
// stands for reach the email.
describe('runDigest and the no-priority updates row', () => {
  let resend: ReturnType<typeof stubResend>
  const sent = (): Array<{ to: string[]; subject: string; html: string }> => resend.calls.map(c => c.body)
  const db = () => getDb(env.DB)
  const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
  const update = (billId: string, newValue: string) =>
    db().insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'bill_updated', billId, userId: 'system',
      metadata: JSON.stringify({ changes: [{ changeType: 'action_added', newValue }] }), createdAt: ago(2),
    })
  const row = () => db().insert(feedEvents).values({ id: 'row', type: 'no_priority_updates' as never, billId: null, userId: 'system', metadata: '{}', createdAt: ago(3) })

  beforeEach(async () => {
    await clearDb()
    resend = stubResend()
    await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
    await seedSession(await seedUser({ email: 'ada@example.com', role: 'admin' }))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('sends nothing for a window holding only the row and its updates', async () => {
    await update(await seedBill({ billNumber: 'H 1', relevanceScore: 6 }), 'Referred to committee')
    await row()

    const result = await runDigest(env as never, db())

    expect(sent()).toHaveLength(0)
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('reports a priority bill\'s update and leaves the row and its bills out', async () => {
    await update(await seedBill({ billNumber: 'H 1', relevanceScore: 6 }), 'Referred to committee')
    await update(await seedBill({ billNumber: 'H 2', priority: 'high' }), 'Passed second reading')
    await row()

    await runDigest(env as never, db())

    expect(sent()).toHaveLength(1)
    expect(sent()[0].subject).toBe('Your daily digest: 1 updated bill')
    expect(sent()[0].html).toContain('Passed second reading')
    expect(sent()[0].html).not.toContain('Referred to committee')
    expect(sent()[0].html).not.toMatch(/no priority/i)
  })
})
