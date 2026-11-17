import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills, feedEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { runDigest } from '../../src/lib/digest'
import { mail, resetMail } from '../mail'

// #1035: the email digest is three parts, each its own: changes to priority bills (the person's digest switch),
// new bills (their new-match switch, for every role), and the saved views they follow (always). An admin's one switch
// for notification emails stops all of it. Seam: runDigest with the
// recording sender, so a test sees who got an email, its subject, its unsubscribe header, and which parts it holds.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const db = () => getDb(env.DB)
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const ago = (h: number) => fmt(Date.now() - h * 3600_000)
const sent = () => mail.sent() as Array<{ to: string[]; subject: string; html: string; headers?: Record<string, string> }>
const to = (addr: string) => sent().filter(m => m.to[0] === addr)
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')

async function person(email: string, role: 'admin' | 'member' | 'owner', opts: { priority?: boolean; found?: boolean } = {}) {
  const id = await seedUser({ email, role, emailDigestEnabled: opts.priority !== false, emailDigestMatchesEnabled: opts.found !== false })
  await seedSession(id)
  return id
}
async function makeView(id: string, name: string, query: string) {
  const creator = await seedUser({ email: `creator-${id}@example.com`, role: 'admin' })
  await env.DB.prepare('INSERT INTO saved_views (id, name, query, slug, created_by, display_order) VALUES (?, ?, ?, ?, ?, 0)')
    .bind(id, name, query, name.toLowerCase().replace(/\s+/g, '-'), creator).run()
}
async function follow(userId: string, viewId: string) {
  await env.DB.prepare('INSERT INTO saved_view_subscriptions (user_id, view_id) VALUES (?, ?)').bind(userId, viewId).run()
}
// A bill older than the window: it is in a view but is not news.
async function settled(over: Parameters<typeof seedBill>[0]) {
  const id = await seedBill(over)
  await db().update(bills).set({ createdAt: ago(24 * 30) }).where(eq(bills.id, id))
  return id
}
async function event(billId: string, createdAt = ago(2)) {
  await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as never, billId, userId: 'system', metadata: JSON.stringify({ position: 'Support' }), createdAt })
}
const routine = (billNumber: string, newMatchAt = ago(1)) =>
  seedBill({ billNumber, state: 'UT', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt, relevanceScore: 7 })

beforeEach(async () => {
  await clearDb()
  resetMail()
  mail.sendBatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
})

describe('runDigest: the three parts', () => {
  it('sends a person with both switches off who follows a view one email with only that view, a views-only subject, and an unsubscribe link to the saved views', async () => {
    await makeView('v-ri', 'Transportation', 'state=RI')
    const ada = await person('ada@example.com', 'member', { priority: false, found: false })
    await follow(ada, 'v-ri')
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    const pri = await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' })
    await event(pri)
    await routine('NM 1')

    await runDigest(env as never, db())

    expect(to('ada@example.com')).toHaveLength(1)
    const m = to('ada@example.com')[0]
    expect(m.subject).toBe('Your daily digest: 1 bill in your saved views')
    expect(text(m.html)).toContain('In your Transportation view')
    expect(text(m.html)).toContain('H 101')
    expect(text(m.html)).not.toContain('P 1')
    expect(text(m.html)).not.toContain('NM 1')
    expect(m.html).toContain('/notifications#setting-saved-views')
    expect(m.html).not.toContain('#setting-email-digest')
    expect(m.headers?.['List-Unsubscribe']).toContain('/notifications#setting-saved-views')
  })

  it('keeps the digest unsubscribe link and header on an email that holds priority bills', async () => {
    await person('pat@example.com', 'member')
    await event(await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' }))

    await runDigest(env as never, db())

    const m = to('pat@example.com')[0]
    expect(m.html).toContain('/notifications#setting-email-digest')
    expect(m.headers?.['List-Unsubscribe']).toContain('/notifications#setting-email-digest')
  })

  it('sends the newly found bills part and no priority part to a person with priority off and newly found on', async () => {
    await person('nia@example.com', 'member', { priority: false, found: true })
    await event(await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' }))
    await routine('NM 7')

    await runDigest(env as never, db())

    const m = to('nia@example.com')[0]
    expect(m.subject).toBe('Your daily digest: 1 new match')
    expect(text(m.html)).toContain('NM 7')
    expect(text(m.html)).not.toContain('P 1')
    expect(m.headers?.['List-Unsubscribe']).toContain('#setting-email-digest')
  })

  it('sends no priority part to a person with priority off, and the priority part to one with it on', async () => {
    await person('off@example.com', 'member', { priority: false, found: false })
    await person('on@example.com', 'member', { priority: true, found: false })
    await event(await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' }))

    await runDigest(env as never, db())

    expect(to('off@example.com')).toHaveLength(0)
    expect(to('on@example.com')).toHaveLength(1)
  })

  it('leaves the newly found part out of an admin who turned it off, and puts it in when on', async () => {
    await person('off@example.com', 'admin', { found: false })
    await person('on@example.com', 'owner', { found: true })
    await event(await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' }))
    await routine('NM 7')

    await runDigest(env as never, db())

    expect(text(to('off@example.com')[0].html)).not.toContain('NM 7')
    expect(to('off@example.com')[0].subject).toBe('Your daily digest: 1 updated bill')
    expect(text(to('on@example.com')[0].html)).toContain('NM 7')
    expect(to('on@example.com')[0].subject).toBe('Your daily digest: 1 updated bill, 1 new match')
  })

  it('sends an admin whose priority switch is off, and newly found on, the newly found part', async () => {
    await person('boss@example.com', 'admin', { priority: false, found: true })
    await routine('NM 7')

    await runDigest(env as never, db())

    expect(to('boss@example.com')).toHaveLength(1)
    expect(text(to('boss@example.com')[0].html)).toContain('NM 7')
  })

  it('shows a priority bill once, under priority bills, to a person who gets that part, and in the view to one who does not', async () => {
    await makeView('v-ri', 'Transportation', 'state=RI')
    const withPart = await person('with@example.com', 'member', { priority: true, found: false })
    const without = await person('without@example.com', 'member', { priority: false, found: false })
    await follow(withPart, 'v-ri'); await follow(without, 'v-ri')
    await event(await settled({ billNumber: 'P 1', state: 'RI', session: '2026', priority: 'high' }))

    await runDigest(env as never, db())

    const a = text(to('with@example.com')[0].html)
    expect(a).toContain('1 priority bill was updated')
    expect(a).not.toContain('In your Transportation view')
    expect(to('with@example.com')[0].subject).toBe('Your daily digest: 1 updated bill')
    const b = text(to('without@example.com')[0].html)
    expect(b).not.toContain('priority bill was updated')
    expect(b).toContain('In your Transportation view')
    expect(b).toContain('P 1')
    expect(to('without@example.com')[0].subject).toBe('Your daily digest: 1 bill in your saved views')
  })

  it('includes a followed view\'s activity a few seconds after the last run\'s stamp', async () => {
    await makeView('v-ri', 'Transportation', 'state=RI')
    const ada = await person('ada@example.com', 'member', { priority: false, found: false })
    await follow(ada, 'v-ri')
    const stamp = Date.now() - 24 * 3600_000
    await db().insert(associationConfig).values({ key: 'last_digest_at', value: fmt(stamp) })
    const bill = await settled({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await event(bill, fmt(stamp + 5_000))

    await runDigest(env as never, db())

    expect(text(to('ada@example.com')[0].html)).toContain('H 101')
  })

  it('leaves out a followed view\'s activity a few seconds before the last run\'s stamp', async () => {
    await makeView('v-ri', 'Transportation', 'state=RI')
    const ada = await person('ada@example.com', 'member', { priority: false, found: false })
    await follow(ada, 'v-ri')
    const stamp = Date.now() - 24 * 3600_000
    await db().insert(associationConfig).values({ key: 'last_digest_at', value: fmt(stamp) })
    const bill = await settled({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await event(bill, fmt(stamp - 5_000))

    await runDigest(env as never, db())

    expect(to('ada@example.com')).toHaveLength(0)
  })

  it('includes a followed view\'s activity on a first run, with no stamp', async () => {
    await makeView('v-ri', 'Transportation', 'state=RI')
    const ada = await person('ada@example.com', 'member', { priority: false, found: false })
    await follow(ada, 'v-ri')
    const bill = await settled({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await event(bill, ago(3))

    await runDigest(env as never, db())

    expect(text(to('ada@example.com')[0].html)).toContain('H 101')
  })
})

describe('runDigest: the notification emails switch', () => {
  async function seedWorld() {
    await makeView('v-ri', 'Transportation', 'state=RI')
    const follower = await person('follower@example.com', 'member')
    await follow(follower, 'v-ri')
    await person('plain@example.com', 'member')
    const admin = await person('admin@example.com', 'admin')
    await follow(admin, 'v-ri')
    await seedBill({ billNumber: 'H 101', state: 'RI', session: '2026' })
    await event(await settled({ billNumber: 'P 1', state: 'UT', session: '2026', priority: 'high' }))
    await routine('NM 7')
  }

  it('sends nothing when an admin turned notification emails off, followed views and priority bills included', async () => {
    await db().insert(associationConfig).values({ key: 'notification_emails_enabled', value: 'false' })
    await seedWorld()

    const result = await runDigest(env as never, db())

    expect(sent()).toHaveLength(0)
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0, skipped: 'off' })
  })

  it('sends every part to people whose switches are on when nothing is saved', async () => {
    await seedWorld()

    await runDigest(env as never, db())

    for (const who of ['follower@example.com', 'admin@example.com']) {
      expect(text(to(who)[0].html)).toContain('H 101')
      expect(text(to(who)[0].html)).toContain('P 1')
      expect(text(to(who)[0].html)).toContain('NM 7')
    }
    expect(text(to('plain@example.com')[0].html)).toContain('NM 7')
  })
})
