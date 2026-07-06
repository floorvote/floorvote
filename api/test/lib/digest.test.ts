import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents, associationConfig } from '../../src/db/schema'
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

  it('excludes non-priority bills and comment events', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const plain = await seedBill({ billNumber: 'H 999', state: 'RI', session: '2026' })
    await addEvent(db, plain, 'bill_updated', '{"changes":[{"changeType":"status_change","oldValue":"a","newValue":"b","detail":null}]}')
    await addEvent(db, billId, 'comment_added', '{}')
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
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

  // ── New keyword-match section (admin/owner only) ────────────────────────────
  const recentMatch = () => new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ')

  it('admins get the New bills section; members get the unchanged digest', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    // priority event so BOTH the member (a@e.com from beforeEach) and admin get a base digest
    await addEvent(db, billId, 'position_set', JSON.stringify({ position: 'Support' }))
    await seedBill({ billNumber: 'NM 42', state: 'RI', session: '2026', matchType: 'keyword', newMatchAt: recentMatch(), relevanceScore: 70, tenantSummary: 'New match summary' })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    await runDigest(env as any, db)
    expect(calls).toHaveLength(2)
    const adminCall = calls.find(c => c.to[0] === 'admin@e.com')
    const memberCall = calls.find(c => c.to[0] === 'a@e.com')
    expect(adminCall.html).toContain('New bills matching your keywords')
    expect(adminCall.html).toContain('NM 42')
    expect(memberCall.html).not.toContain('New bills matching your keywords')
    expect(memberCall.html).not.toContain('NM 42')
  })

  it('admins still get a digest when only new matches exist; members get nothing', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    await seedBill({ billNumber: 'NM 7', state: 'RI', session: '2026', matchType: 'keyword', newMatchAt: recentMatch(), relevanceScore: 50 })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toEqual(['admin@e.com'])
    expect(calls[0].html).toContain('NM 7')
    expect(result.sent).toBe(1)
  })

  it('excludes prioritized and dismissed bills from the new-match section', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const admin = await seedUser({ email: 'admin@e.com', role: 'admin' }); await seedSession(admin)
    await seedBill({ billNumber: 'PRI 1', state: 'RI', session: '2026', matchType: 'keyword', newMatchAt: recentMatch(), priority: 'high', relevanceScore: 90 })
    await seedBill({ billNumber: 'DIS 1', state: 'RI', session: '2026', matchType: 'keyword', newMatchAt: recentMatch(), triageDismissedAt: recentMatch(), relevanceScore: 90 })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    // PRI 1 has a priority (drives the normal digest? no event → not in events); DIS 1 dismissed.
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
    await seedBill({ billNumber: 'OLD 1', state: 'RI', session: '2026', matchType: 'keyword', newMatchAt: old, relevanceScore: 90 })
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
    await seedBill({ billNumber: 'LOW 1', state: 'RI', session: '2026', matchType: 'keyword', newMatchAt: recentMatch(), relevanceScore: 30 })
    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(0) // below threshold → excluded → nothing to send
    expect(result.sent).toBe(0)
  })
})
