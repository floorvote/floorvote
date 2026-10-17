import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents, associationConfig, bills } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

async function enableModule(db: ReturnType<typeof getDb>) {
  const v = JSON.stringify({ 'email-digest': true })
  await db.insert(associationConfig).values({ key: 'modules', value: v })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: v } })
}
async function addEvent(db: ReturnType<typeof getDb>, billId: string, type: string, metadata: string) {
  await db.insert(feedEvents).values({ id: crypto.randomUUID(), type: type as any, billId, userId: 'system', metadata })
}

describe('runDigest', () => {
  let billId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const u = await seedUser({ email: 'a@e.com' }); await seedSession(u)
    billId = await seedBill({ billNumber: 'H 1', state: 'RI', session: '2026', priority: 'high' })
  })

  it('no-ops (no send) when the module is disabled', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const db = getDb(env.DB)
    await addEvent(db, billId, 'bill_updated', JSON.stringify({ changes: [{ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null }] }))
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('sends a batch when enabled + priority bill has activity + active opted-in recipient', async () => {
    const db = getDb(env.DB); await enableModule(db)
    await addEvent(db, billId, 'bill_updated', JSON.stringify({ changes: [{ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null }] }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toEqual(['a@e.com'])
    expect(calls[0].html).toContain('H 1')
    const stamp = await db.select().from(associationConfig).where(eq(associationConfig.key, 'last_digest_at')).get()
    expect(stamp?.value).toBeTruthy()
    // Return value: 1 recipient, 1 sent (mock returns 200), 0 failed
    expect(result).toEqual({ ok: true, recipients: 1, sent: 1, failed: 0 })
  })

  it('sends nothing when no qualifying activity', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('excludes events on non-priority bills', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const plain = await seedBill({ billNumber: 'H 999', state: 'RI', session: '2026' })
    await addEvent(db, plain, 'bill_updated', '{"changes":[{"changeType":"status_change","oldValue":"a","newValue":"b","detail":null}]}')
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('includes comment_added on priority bills', async () => {
    const db = getDb(env.DB); await enableModule(db)
    await addEvent(db, billId, 'comment_added', JSON.stringify({ preview: 'We should testify against this at the hearing.', commentId: 'c-test-1' }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toEqual(['a@e.com'])
    expect(calls[0].html).toContain('We should testify against this at the hearing.')
    expect(result).toEqual({ ok: true, recipients: 1, sent: 1, failed: 0 })
  })

  it('includes priority_set on priority bills', async () => {
    const db = getDb(env.DB); await enableModule(db)
    await addEvent(db, billId, 'priority_set', JSON.stringify({ priority: 'high' }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toEqual(['a@e.com'])
    expect(calls[0].html).toContain('Marked high priority')
    expect(result).toEqual({ ok: true, recipients: 1, sent: 1, failed: 0 })
  })

  it('respects per-user opt-out (no recipients → no send)', async () => {
    await resetDb(); await applyMigrations()
    const db = getDb(env.DB); await enableModule(db)
    const u = await seedUser({ email: 'out@e.com', emailDigestEnabled: false }); await seedSession(u)
    const b = await seedBill({ billNumber: 'H 2', state: 'RI', session: '2026', priority: 'high' })
    await addEvent(db, b, 'position_set', JSON.stringify({ position: 'Support' }))
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('returns nonzero failed when the email provider rejects a send', async () => {
    const db = getDb(env.DB); await enableModule(db)
    await addEvent(db, billId, 'bill_updated', JSON.stringify({ changes: [{ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null }] }))
    // Mock fetch to return a non-200 status — sendBatch counts this as failed.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    const result = await runDigest(env as any, db)
    expect(result).toEqual({ ok: true, recipients: 1, sent: 0, failed: 1 })
  })

  it('includes same-day DB-format events after an ISO last_digest_at cursor (format-agnostic)', async () => {
    const db = getDb(env.DB); await enableModule(db)
    // Cursor set to 1 hour ago in ISO format (same day).
    const isoCursor = new Date(Date.now() - 3600_000).toISOString()
    await db.insert(associationConfig).values({ key: 'last_digest_at', value: isoCursor })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: isoCursor } })
    // Event inserted WITHOUT createdAt → gets DB default datetime('now') = space-format, "now" (after the cursor in real time).
    await addEvent(db, billId, 'bill_updated', JSON.stringify({ changes: [{ changeType: 'status_change', oldValue: 'a', newValue: 'b', detail: null }] }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(1)   // event must be included despite the format mismatch
    expect(result.sent).toBe(1)
  })

  it('excludes suppressed events', async () => {
    const db = getDb(env.DB); await enableModule(db)
    await db.insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as any, billId, userId: 'system', metadata: JSON.stringify({ position: 'Support' }), suppressed: true })
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()   // only event is suppressed → nothing to send
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  async function enableWeekly(db: ReturnType<typeof getDb>, weeklyDay: string) {
    const v = JSON.stringify({ 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay } } })
    await db.insert(associationConfig).values({ key: 'modules', value: v })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: v } })
  }

  it('weekly: skips and does NOT stamp last_digest_at on a non-matching weekday', async () => {
    const db = getDb(env.DB)
    // 2026-06-03 is a Wednesday (getUTCDay() === 3); configure weekly on Monday (1).
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-03T11:00:00Z'))
    await enableWeekly(db, '1')
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
    const stamp = await db.select().from(associationConfig).where(eq(associationConfig.key, 'last_digest_at')).get()
    expect(stamp).toBeUndefined()           // never stamped → window preserved
  })

  it('weekly: sends on the matching weekday', async () => {
    const db = getDb(env.DB)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-03T11:00:00Z'))  // Wednesday
    await enableWeekly(db, '3')                                             // weekly on Wednesday
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(1)
    expect(result).toEqual({ ok: true, recipients: 1, sent: 1, failed: 0 })
    const stamp = await db.select().from(associationConfig).where(eq(associationConfig.key, 'last_digest_at')).get()
    expect(stamp?.value).toBeTruthy()
  })

  it('weekly + ignoreSchedule: sends even on a non-matching weekday', async () => {
    const db = getDb(env.DB)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-03T11:00:00Z'))  // Wednesday
    await enableWeekly(db, '1')                                             // configured Monday
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db, { ignoreSchedule: true })
    expect(calls).toHaveLength(1)
    expect(result.sent).toBe(1)
  })

  it('daily: the summary line says the last day', async () => {
    const db = getDb(env.DB); await enableModule(db)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-03T11:00:00Z'))
    await db.insert(associationConfig).values({ key: 'last_digest_at', value: '2026-06-02 11:00:00' })
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await runDigest(env as any, db)
    expect(calls[0].html).toContain('was updated in the last day')
  })

  it('weekly: the summary line says the last week', async () => {
    const db = getDb(env.DB)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-03T11:00:00Z'))  // Wednesday
    await enableWeekly(db, '3')
    await db.insert(associationConfig).values({ key: 'last_digest_at', value: '2026-05-27 11:00:00' })
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await runDigest(env as any, db)
    expect(calls[0].html).toContain('was updated in the last week')
  })

  // ── New keyword-match section (admins always, members unless they opt out) ──
  // Members' options are covered in digestMemberMatches.test.ts.
  const recentMatch = () => new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ')

  it('admins and members (option on by default) get the new-match section', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    // priority event so BOTH the member (a@e.com from beforeEach) and admin get a base digest
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    await seedBill({ billNumber: 'NM 42', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 70, tenantSummary: 'New match summary' })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await runDigest(env as any, db)
    expect(calls).toHaveLength(2)
    const adminCall = calls.find(c => c.to[0] === 'admin@e.com')
    const memberCall = calls.find(c => c.to[0] === 'a@e.com')
    expect(adminCall.html).toContain('1 new match')
    expect(adminCall.html).toContain('NM 42')
    expect(memberCall.html).toContain('1 new match')
    expect(memberCall.html).toContain('NM 42')
  })

  it('a window with only new matches sends a digest to the admin and to the member with the option on', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    await seedBill({ billNumber: 'NM 7', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 50 })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls.map(c => c.to[0]).sort()).toEqual(['a@e.com', 'admin@e.com'])
    for (const c of calls) expect(c.html).toContain('NM 7')
    expect(result.sent).toBe(2)
  })

  it('caps the admin new-match section at the 10 most relevant, with the full count and a "See all N new matches" link', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    for (let i = 1; i <= 12; i++) {
      await seedBill({ billNumber: `NM ${100 + i}`, state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 50 + i })
    }
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await runDigest(env as any, db)
    const adminCall = calls.find(c => c.to[0] === 'admin@e.com')
    const html: string = adminCall.html
    expect(html).toContain('12 new matches')
    expect(html).toContain('NM 112')                 // most relevant is listed
    expect(html).not.toContain('NM 101')             // the two least relevant are cut
    expect(html).not.toContain('NM 102')
    expect(html).toContain('NM 103')                 // the 10th most relevant is the last listed
    expect(html).toContain('See all 12 new matches')
    expect(html).toContain(`${env.APP_URL}/bills?newMatches=1`)
    expect(adminCall.subject).toBe('Your daily digest: 12 new matches')
  })

  // ── #586: the subject names each kind and its count; new matches are full cards ──
  const capture = () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    return calls
  }
  const newMatch = (billNumber: string, extra: Record<string, unknown> = {}) =>
    seedBill({ billNumber, state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 70, ...extra })

  it('subject: an admin whose digest has both kinds sees both counts, a member with the option off sees only updates', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    const off = await seedUser({ email: 'off@e.com', role: 'member', emailDigestMatchesEnabled: false }); await seedSession(off)
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    await newMatch('NM 1'); await newMatch('NM 2'); await newMatch('NM 3')
    const calls = capture()
    await runDigest(env as any, db)
    expect(calls.find(c => c.to[0] === 'admin@e.com').subject).toBe('Your daily digest: 1 updated bill, 3 new matches')
    expect(calls.find(c => c.to[0] === 'a@e.com').subject).toBe('Your daily digest: 1 updated bill, 3 new matches')
    const offCall = calls.find(c => c.to[0] === 'off@e.com')
    expect(offCall.subject).toBe('Your daily digest: 1 updated bill')
    expect(offCall.html).not.toContain('In this digest')
    expect(offCall.html).not.toContain('digest-new-matches')
  })

  it('subject: a window of seven days is a weekly digest', async () => {
    const db = getDb(env.DB)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-03T11:00:00Z'))
    await enableWeekly(db, '3')
    await db.insert(associationConfig).values({ key: 'last_digest_at', value: '2026-05-27 11:00:00' })
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    await newMatch('NM 1')
    const calls = capture()
    await runDigest(env as any, db)
    expect(calls[0].subject).toBe('Your weekly digest: 1 updated bill, 1 new match')
    expect(calls[0].html).toContain('Your digest for the last week')
  })

  it('subject: updates only, daily', async () => {
    const db = getDb(env.DB); await enableModule(db)
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    const calls = capture()
    await runDigest(env as any, db)
    expect(calls[0].subject).toBe('Your daily digest: 1 updated bill')
  })

  it('subject: counts distinct updated bills, not events', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const other = await seedBill({ billNumber: 'H 2', state: 'RI', session: '2026', priority: 'low' })
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    await addEvent(db, billId, 'comment_added', JSON.stringify({ preview: 'Noted.' }))
    await addEvent(db, other, 'position_set', JSON.stringify({ position: 'Oppose' }))
    const calls = capture()
    await runDigest(env as any, db)
    expect(calls[0].subject).toBe('Your daily digest: 2 updated bills')
  })

  it('a new match\'s summary reaches its card, and a match with none gets no preview', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    await newMatch('NM 1', { tenantSummary: 'Lets counties start mail ballot processing early.' })
    await newMatch('NM 2')
    const calls = capture()
    await runDigest(env as any, db)
    const html: string = calls.find(c => c.to[0] === 'admin@e.com').html
    expect(html).toContain('Lets counties start mail ballot processing early.')
    expect(html.match(/padding:0 14px 10px 14px/g) ?? []).toHaveLength(1)
    expect(html).toContain('>New match<')
  })

  it('no digest, to an admin or a member, ever says "keyword"', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    for (let i = 1; i <= 11; i++) await newMatch(`NM ${i}`, { relevanceScore: 50 + i })
    const calls = capture()
    await runDigest(env as any, db)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) {
      expect(c.html).not.toMatch(/keyword/i)
      expect(c.subject).not.toMatch(/keyword/i)
    }
  })

  it('excludes prioritized and dismissed bills from the new-match section', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    // PRI 1 is prioritized, which latches triaged_at (setting a priority is an act of triage).
    await seedBill({ billNumber: 'PRI 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), priority: 'high', triagedAt: recentMatch(), relevanceScore: 90 })
    await seedBill({ billNumber: 'DIS 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), triagedAt: recentMatch(), relevanceScore: 90 })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    // PRI 1 has a priority and is latched as triaged (no event → not in events); DIS 1 dismissed.
    // Neither qualifies as a new match, and there are no priority events → nothing sent.
    expect(calls).toHaveLength(0)
    expect(result.sent).toBe(0)
  })

  it('excludes new matches before the last_digest_at window', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    const since = new Date(Date.now() - 3600_000).toISOString() // 1h ago
    await db.insert(associationConfig).values({ key: 'last_digest_at', value: since })
    const old = new Date(Date.now() - 7200_000).toISOString().slice(0, 19).replace('T', ' ') // 2h ago, before window
    await seedBill({ billNumber: 'OLD 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: old, relevanceScore: 90 })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(0)
    expect(result.sent).toBe(0)
  })

  it('respects new_match_min_relevance for the digest section', async () => {
    const db = getDb(env.DB); await enableModule(db)
    await db.insert(associationConfig).values({ key: 'new_match_min_relevance', value: '60' })
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    await seedBill({ billNumber: 'LOW 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 30 })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(0) // below threshold → excluded → nothing to send
    expect(result.sent).toBe(0)
  })

  // Triaging any bill in a companion group triages the group (groupUntriaged), so a match
  // whose companion was triaged is no longer new and stays out of the digest.
  describe('companion groups', () => {
    // Groups bills the way a recompute writes the key: the smallest member id.
    async function group(db: ReturnType<typeof getDb>, ...ids: string[]) {
      await db.update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
    }
    const captureEmails = () => {
      const calls: any[] = []
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
      return calls
    }

    it('leaves out a routine new match whose companion in the same group was triaged', async () => {
      const db = getDb(env.DB); await enableModule(db)
      const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
      const fresh = await seedBill({ billNumber: 'GRP 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
      const triaged = await seedBill({ billNumber: 'GRP 2', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90, triagedAt: recentMatch() })
      await group(db, fresh, triaged)
      const calls = captureEmails()

      const result = await runDigest(env as any, db)

      // GRP 1 has no triage of its own, but its companion's triage triages the group.
      expect(calls).toHaveLength(0)
      expect(result.sent).toBe(0)
    })

    it('leaves out the match but still lists an ungrouped new match beside it', async () => {
      const db = getDb(env.DB); await enableModule(db)
      const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
      const fresh = await seedBill({ billNumber: 'GRP 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
      // The triaged companion is not itself a new match (it has no newMatchAt).
      const triaged = await seedBill({ billNumber: 'GRP 2', state: 'RI', session: '2026', matchType: 'keyword', relevanceScore: 90, triagedAt: recentMatch() })
      await group(db, fresh, triaged)
      await seedBill({ billNumber: 'SOLO 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
      const calls = captureEmails()

      await runDigest(env as any, db)

      // The admin and the member (option on by default) each get one digest.
      expect(calls).toHaveLength(2)
      for (const c of calls) {
        expect(c.html).toContain('1 new match')
        expect(c.html).toContain('SOLO 1')
        expect(c.html).not.toContain('GRP 1')
      }
    })

    it('lists a routine new match in a group where no member is triaged', async () => {
      const db = getDb(env.DB); await enableModule(db)
      const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
      const first = await seedBill({ billNumber: 'GRP 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
      // A companion that is not a new match (no newMatchAt) and not triaged either.
      const second = await seedBill({ billNumber: 'GRP 2', state: 'RI', session: '2026', matchType: 'keyword', relevanceScore: 90 })
      await group(db, first, second)
      const calls = captureEmails()

      await runDigest(env as any, db)

      expect(calls).toHaveLength(2)
      for (const c of calls) {
        expect(c.html).toContain('1 new match')
        expect(c.html).toContain('GRP 1')
      }
    })

    it('lists every routine new match of an untriaged group', async () => {
      const db = getDb(env.DB); await enableModule(db)
      const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
      const first = await seedBill({ billNumber: 'GRP 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
      const second = await seedBill({ billNumber: 'GRP 2', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 80 })
      await group(db, first, second)
      const calls = captureEmails()

      await runDigest(env as any, db)

      expect(calls).toHaveLength(2)
      for (const c of calls) {
        expect(c.html).toContain('2 new matches')
        expect(c.html).toContain('GRP 1')
        expect(c.html).toContain('GRP 2')
      }
    })

    it('does not let a triaged bill in another group affect a new match', async () => {
      const db = getDb(env.DB); await enableModule(db)
      const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
      const fresh = await seedBill({ billNumber: 'GRP 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
      const freshMate = await seedBill({ billNumber: 'GRP 2', state: 'RI', session: '2026', matchType: 'keyword', relevanceScore: 90 })
      const otherA = await seedBill({ billNumber: 'OTH 1', state: 'RI', session: '2026', matchType: 'keyword', relevanceScore: 90 })
      const otherB = await seedBill({ billNumber: 'OTH 2', state: 'RI', session: '2026', matchType: 'keyword', relevanceScore: 90, triagedAt: recentMatch() })
      await group(db, fresh, freshMate)
      await group(db, otherA, otherB)
      const calls = captureEmails()

      await runDigest(env as any, db)

      expect(calls).toHaveLength(2)
      for (const c of calls) {
        expect(c.html).toContain('GRP 1')
        expect(c.html).not.toContain('OTH')
      }
    })

    // #550: a companion analyzed only because of its group (a pulled companion) has no match type, so it is
    // never a new match, whatever its group holds. The digest's new-match section is keyed on match_type = 'keyword'.
    describe('a pulled companion', () => {
      const pulled = (billNumber: string, more: Parameters<typeof seedBill>[0] = {}) =>
        seedBill({ billNumber, state: 'RI', session: '2026', matchType: null, aiProcessedAt: recentMatch(), tenantSummary: 'Analyzed through its group', relevanceScore: 90, ...more })

      it('is left out of the new-match section, for an admin and for a member', async () => {
        const db = getDb(env.DB); await enableModule(db)
        const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
        const tracked = await seedBill({ billNumber: 'TRK 1', state: 'RI', session: '2026', matchType: 'manual', relevanceScore: 90 })
        const companion = await pulled('PUL 1')
        await group(db, tracked, companion)
        const calls = captureEmails()

        const result = await runDigest(env as any, db)

        expect(calls).toHaveLength(0)
        expect(result.sent).toBe(0)
      })

      it('is left out beside a routine new match, which is still listed', async () => {
        const db = getDb(env.DB); await enableModule(db)
        const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
        const tracked = await seedBill({ billNumber: 'TRK 1', state: 'RI', session: '2026', matchType: 'manual', relevanceScore: 90 })
        const companion = await pulled('PUL 1')
        await group(db, tracked, companion)
        await seedBill({ billNumber: 'SOLO 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
        const calls = captureEmails()

        await runDigest(env as any, db)

        expect(calls).toHaveLength(2)
        for (const c of calls) {
          expect(c.html).toContain('>1 new match</td>')
          expect(c.html).toContain('SOLO 1')
          expect(c.html).not.toContain('PUL 1')
        }
      })

      it('is left out of a group whose tracked bill is itself a routine new match, which counts once', async () => {
        const db = getDb(env.DB); await enableModule(db)
        const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
        const tracked = await seedBill({ billNumber: 'TRK 1', state: 'RI', session: '2026', matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch(), relevanceScore: 90 })
        const companion = await pulled('PUL 1')
        await group(db, tracked, companion)
        const calls = captureEmails()

        await runDigest(env as any, db)

        expect(calls).toHaveLength(2)
        for (const c of calls) {
          expect(c.html).toContain('>1 new match</td>')
          expect(c.html).toContain('TRK 1')
          expect(c.html).not.toContain('PUL 1')
        }
      })

      it('is left out even when a declaration had leaked onto its row, since it has no match type', async () => {
        const db = getDb(env.DB); await enableModule(db)
        const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
        const tracked = await seedBill({ billNumber: 'TRK 1', state: 'RI', session: '2026', matchType: 'manual', relevanceScore: 90 })
        const companion = await pulled('PUL 1', { matchProvenance: 'routine', newMatchAt: recentMatch() })
        await group(db, tracked, companion)
        const calls = captureEmails()

        const result = await runDigest(env as any, db)

        expect(calls).toHaveLength(0)
        expect(result.sent).toBe(0)
      })

      it('is listed once it matches on its own with a routine declaration', async () => {
        const db = getDb(env.DB); await enableModule(db)
        const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
        const tracked = await seedBill({ billNumber: 'TRK 1', state: 'RI', session: '2026', matchType: 'manual', relevanceScore: 90 })
        const companion = await pulled('PUL 1')
        await group(db, tracked, companion)
        await db.update(bills).set({ matchType: 'keyword', matchProvenance: 'routine', newMatchAt: recentMatch() }).where(eq(bills.id, companion))
        const calls = captureEmails()

        await runDigest(env as any, db)

        expect(calls).toHaveLength(2)
        for (const c of calls) {
          expect(c.html).toContain('>1 new match</td>')
          expect(c.html).toContain('PUL 1')
        }
      })
    })
  })
})
