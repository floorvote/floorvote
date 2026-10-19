import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, emailSendStats, feedEvents } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { fakeBinding, stubResend } from '../../../shared/emailTestKit'

// The digest and the week-ahead email send through the bulk purpose (#708),
// end to end: real sender, real adapters, with the Cloudflare binding and
// `fetch` (Resend) faked at the transport. Bulk mail never falls back, uses the
// bulk From address, counts each send to the provider that sent it, and is
// suppressed in demo mode.

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

/** A Cloudflare binding whose behavior is chosen per recipient. */
function binding(behave: (to: string) => 'ok' | 'outage' | 'suppressed' = () => 'ok') {
  return fakeBinding((m) => {
    const how = behave([m.to].flat()[0])
    return how === 'outage' ? 'down' : how
  })
}

/** Both providers configured, the binding first. Resend is the one a fallback would reach. */
function bothProviders(cf: ReturnType<typeof binding>, extra: Record<string, string> = {}) {
  return { ...env, EMAIL_PROVIDER: 'cloudflare', EMAIL: cf.binding, ...extra } as never
}

let resend: ReturnType<typeof stubResend>
const resendBodies = () => resend.calls.map(c => c.body)
beforeEach(async () => {
  await resetDb(); await applyMigrations()
  resend = stubResend()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function stats() {
  const rows = await getDb(env.DB).select().from(emailSendStats).all()
  const by: Record<string, (typeof rows)[number]> = {}
  for (const r of rows) by[r.provider] = r
  return by
}

async function enableDigest(recipients: string[]) {
  const db = getDb(env.DB)
  const v = JSON.stringify({ 'email-digest': true })
  await db.insert(associationConfig).values({ key: 'modules', value: v })
  for (const email of recipients) await seedSession(await seedUser({ email }))
  const billId = await seedBill({ billNumber: 'H 1', state: 'RI', session: '2026', priority: 'high' })
  await db.insert(feedEvents).values({
    id: crypto.randomUUID(), type: 'priority_set' as any, billId, userId: 'system', metadata: JSON.stringify({ priority: 'high' }),
  })
}

async function enableWeekAhead(recipients: string[]) {
  const db = getDb(env.DB)
  const weekday = String(new Date().getUTCDay())
  await db.insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
  for (const email of recipients) await seedSession(await seedUser({ email }))
  const bill = await seedBill({ billNumber: 'HB 100', state: 'DC', priority: 'high' })
  await seedCalendarEvent(bill, { kind: 'hearing', date: isoDay(2), description: 'Public Hearing on HB 100' })
}

const stamp = async (key: string) => (await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, key)).get())?.value

// The same four properties for each of the two bulk emails.
describe.each([
  { name: 'digest', stampKey: 'last_digest_at', subject: /digest|updated|new match/i, unsub: 'setting-email-digest',
    enable: enableDigest, run: (e: never) => runDigest(e, getDb(env.DB)) },
  { name: 'week-ahead', stampKey: 'last_week_ahead_at', subject: /week ahead/i, unsub: 'setting-week-ahead',
    enable: enableWeekAhead, run: (e: never) => runWeekAhead(e, getDb(env.DB)) },
])('$name email', ({ stampKey, subject, unsub, enable, run }) => {
  const members = ['a@example.com', 'b@example.com', 'c@example.com']

  it('makes no attempt on the second provider when the first is down, and counts every failure', async () => {
    await enable(members)
    const cf = binding(() => 'outage')
    await run(bothProviders(cf))
    expect(cf.sent).toHaveLength(3)
    expect(resendBodies()).toHaveLength(0)
    const by = await stats()
    expect(by.cloudflare).toMatchObject({ sent: 0, failed: 3, suppressed: 0 })
    expect(by.resend).toBeUndefined()
  })

  it('stamps "last sent" even when every send failed, as before', async () => {
    await enable(members)
    expect(await stamp(stampKey)).toBeUndefined()
    await run(bothProviders(binding(() => 'outage')))
    expect(await stamp(stampKey)).toBeTruthy()
  })

  it('sends from EMAIL_FROM_BULK when it is set', async () => {
    await enable(members.slice(0, 1))
    const cf = binding()
    await run(bothProviders(cf, { EMAIL_FROM: 'notifications@example.org', EMAIL_FROM_BULK: 'notifications@mail.example.org' }))
    expect(cf.sent[0].from).toBe('FloorVote <notifications@mail.example.org>')
  })

  it('sends from EMAIL_FROM when EMAIL_FROM_BULK is unset', async () => {
    await enable(members.slice(0, 1))
    const cf = binding()
    await run(bothProviders(cf, { EMAIL_FROM: 'notifications@example.org' }))
    expect(cf.sent[0].from).toBe('FloorVote <notifications@example.org>')
  })

  it('sends over Resend from the bulk From address when Resend is the only provider', async () => {
    await enable(members.slice(0, 1))
    await run({ ...env, EMAIL_FROM: 'notifications@example.org', EMAIL_FROM_BULK: 'notifications@mail.example.org' } as never)
    expect(resendBodies()).toHaveLength(1)
    expect(resendBodies()[0].from).toBe('FloorVote <notifications@mail.example.org>')
  })

  it('carries the unsubscribe header and a subject', async () => {
    await enable(members.slice(0, 1))
    const cf = binding()
    await run(bothProviders(cf))
    const sent = cf.sent[0]
    expect(sent.headers['List-Unsubscribe']).toContain(`/profile#${unsub}`)
    expect(sent.subject).toMatch(subject)
  })

  it('counts a suppressed recipient as suppressed, not failed, and does not retry it on the second provider', async () => {
    await enable(members)
    const cf = binding(to => (to === 'b@example.com' ? 'suppressed' : 'ok'))
    await run(bothProviders(cf))
    expect(resendBodies()).toHaveLength(0)
    expect((await stats()).cloudflare).toMatchObject({ sent: 2, failed: 0, suppressed: 1 })
  })

  it('counts a mixed batch per send: delivered, suppressed, and failed, all to the first provider', async () => {
    await enable(members)
    const cf = binding(to => ({ 'a@example.com': 'ok', 'b@example.com': 'suppressed', 'c@example.com': 'outage' } as const)[to as 'a@example.com'])
    await run(bothProviders(cf))
    expect(resendBodies()).toHaveLength(0)
    expect((await stats()).cloudflare).toMatchObject({ sent: 1, failed: 1, suppressed: 1 })
  })

  it('counts Resend sends to Resend when Resend is the only provider', async () => {
    await enable(members)
    await run(env as never)
    expect(resendBodies().map(b => b.to[0]).sort()).toEqual(members)
    expect((await stats()).resend).toMatchObject({ sent: 3, failed: 0 })
  })

  it('sends nothing, counts nothing, and still stamps "last sent" in demo mode', async () => {
    await enable(members)
    const cf = binding()
    await run(bothProviders(cf, { DEMO_MODE: 'true' }))
    expect(cf.sent).toHaveLength(0)
    expect(resendBodies()).toHaveLength(0)
    expect(Object.keys(await stats())).toEqual([])
    expect(await stamp(stampKey)).toBeTruthy()
  })

  it('sends when demo mode is off', async () => {
    await enable(members.slice(0, 1))
    const cf = binding()
    await run(bothProviders(cf, { DEMO_MODE: 'false' }))
    expect(cf.sent).toHaveLength(1)
  })

  it('refuses a malformed stored address before any provider, counts nothing for it, and sends the rest', async () => {
    await enable(['a@example.com', 'not-an-address'])
    const cf = binding()
    await run(bothProviders(cf))
    expect(cf.sent).toHaveLength(1)
    expect((await stats()).cloudflare).toMatchObject({ sent: 1, failed: 0 })
  })
})

describe('the digest result', () => {
  const members = ['a@example.com', 'b@example.com', 'c@example.com']

  it('reports sent and failed over the batch, with a suppressed recipient among the failed', async () => {
    await enableDigest(members)
    const cf = binding(to => ({ 'a@example.com': 'ok', 'b@example.com': 'suppressed', 'c@example.com': 'outage' } as const)[to as 'a@example.com'])
    expect(await runDigest(bothProviders(cf), getDb(env.DB))).toEqual({ ok: true, recipients: 3, sent: 1, failed: 2 })
  })

  it('reports no sends and no failures in demo mode', async () => {
    await enableDigest(members)
    const r = await runDigest(bothProviders(binding(), { DEMO_MODE: 'true' }), getDb(env.DB))
    expect(r).toEqual({ ok: true, recipients: 3, sent: 0, failed: 0 })
  })

  it('sends a batch larger than the concurrency bound, each recipient once', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`)
    await enableDigest(many)
    const cf = binding()
    const r = await runDigest(bothProviders(cf), getDb(env.DB))
    expect(r).toMatchObject({ recipients: 21, sent: 21, failed: 0 })
    expect(new Set(cf.sent.map(m => [m.to].flat()[0])).size).toBe(21)
    expect((await stats()).cloudflare).toMatchObject({ sent: 21, failed: 0 })
  })
})
