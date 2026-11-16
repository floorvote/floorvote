import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, feedEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { runDigest } from '../../src/lib/digest'
import { mail, resetMail } from '../mail'

// #1036: admins choose what members get for newly found bills unless they change it. "Priority bills and newly found
// bills" is the email-digest module's newBillsDefault on (and unset), "Priority bills only" is it off. A person's own
// choice can be unset: a member's then follows the default, and an admin's or owner's is on. Changing the switch
// sets the choice, and the default never overrides it.
// Seam: runDigest with the recording sender, so a test sees who got an email and which parts it holds.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const db = () => getDb(env.DB)
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const ago = (h: number) => fmt(Date.now() - h * 3600_000)
const sent = () => mail.sent() as Array<{ to: string[]; subject: string; html: string }>
const to = (addr: string) => sent().filter(m => m.to[0] === addr)
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

/** The team sends the digest (On), with the default for newly found bills set as given. */
async function teamDefault(newBillsDefault: boolean) {
  const value = JSON.stringify({ 'email-digest': { enabled: true, settings: { frequency: 'daily', newBillsDefault } } })
  await db().insert(associationConfig).values({ key: 'modules', value })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value } })
}
const priorityBillsOnly = () => teamDefault(false)
const priorityAndNewlyFound = () => teamDefault(true)

/** A signed-in person whose "Newly found bills" choice is unset (null), on, or off. Their priority switch is on. */
async function person(email: string, role: 'admin' | 'member' | 'owner', newlyFound: boolean | null) {
  const id = await seedUser({ email, role, emailDigestMatchesEnabled: newlyFound })
  await seedSession(id)
  return id
}
/** A priority bill with news in the window, so everyone with the priority part gets an email. */
async function priorityNews() {
  const id = await seedBill({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
  await db().update(bills).set({ createdAt: ago(24 * 30) }).where(eq(bills.id, id))
  await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as never, billId: id, userId: 'system', metadata: JSON.stringify({ position: 'Support' }), createdAt: ago(2) })
}
const routine = (billNumber: string, newMatchAt = ago(1)) =>
  seedBill({ billNumber, state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt, relevanceScore: 7 })

beforeEach(async () => {
  await clearDb()
  resetMail()
  mail.sendBatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
})

describe('runDigest: the team default for newly found bills', () => {
  it('sends a member with no choice no newly found part under "Priority bills only"', async () => {
    await priorityBillsOnly()
    await person('ana@example.com', 'member', null)
    await priorityNews()
    await routine('NM 7')

    await runDigest(env as never, db())

    expect(to('ana@example.com')).toHaveLength(1)
    expect(to('ana@example.com')[0].subject).toBe('Your daily digest: 1 updated bill')
    expect(text(to('ana@example.com')[0].html)).toContain('P 1')
    expect(text(to('ana@example.com')[0].html)).not.toContain('NM 7')
  })

  it('sends a member who turned "Newly found bills" on the newly found part under "Priority bills only"', async () => {
    await priorityBillsOnly()
    await person('ben@example.com', 'member', true)
    await priorityNews()
    await routine('NM 7')

    await runDigest(env as never, db())

    expect(to('ben@example.com')[0].subject).toBe('Your daily digest: 1 updated bill, 1 new match')
    expect(text(to('ben@example.com')[0].html)).toContain('NM 7')
  })

  it('sends an admin or owner with no choice the newly found part under "Priority bills only"', async () => {
    await priorityBillsOnly()
    await person('admin@example.com', 'admin', null)
    await person('owner@example.com', 'owner', null)
    await priorityNews()
    await routine('NM 7')

    await runDigest(env as never, db())

    for (const who of ['admin@example.com', 'owner@example.com']) {
      expect(to(who)[0].subject, who).toBe('Your daily digest: 1 updated bill, 1 new match')
      expect(text(to(who)[0].html), who).toContain('NM 7')
    }
  })

  it('gives a member with no choice the newly found part on the next run once the default is back to "Priority bills and newly found bills", and not a member who turned it off', async () => {
    await priorityBillsOnly()
    await person('una@example.com', 'member', null)
    await person('off@example.com', 'member', false)
    await routine('NM 7')

    await runDigest(env as never, db())

    expect(sent()).toHaveLength(0)

    await priorityAndNewlyFound()
    // The next run, half an hour on: a bill found since.
    await db().update(associationConfig).set({ value: ago(0.5) }).where(eq(associationConfig.key, 'last_digest_at'))
    await routine('NM 8', ago(0.25))

    await runDigest(env as never, db())

    expect(to('una@example.com')).toHaveLength(1)
    expect(to('una@example.com')[0].subject).toBe('Your daily digest: 1 new match')
    expect(text(to('una@example.com')[0].html)).toContain('NM 8')
    expect(to('off@example.com')).toHaveLength(0)
  })
})
