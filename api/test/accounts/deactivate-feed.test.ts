import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents, users, associationConfig } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'

afterEach(() => { vi.unstubAllGlobals() })

describe('deactivated members\' feed events are hidden from /api/feed', () => {
  let memberTok: string, billId: string, activeId: string, goneId: string

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    activeId = await seedUser({ role: 'member', email: 'active@x.com', name: 'Active Member' })
    goneId = await seedUser({ role: 'member', email: 'gone@x.com', name: 'Gone Member', deactivatedAt: new Date().toISOString() })
    memberTok = await seedSession(activeId)
    billId = await seedBill({ matchType: 'keyword', title: 'Feed bill', priority: 'high' })
    const db = getDb(env.DB)
    await db.insert(feedEvents).values([
      { id: crypto.randomUUID(), type: 'priority_set', billId, userId: goneId, metadata: '{}', createdAt: '2026-01-01T09:00:00Z' },
      { id: crypto.randomUUID(), type: 'comment_added', billId, userId: activeId, metadata: '{}', createdAt: '2026-01-01T10:00:00Z' },
    ])
  })

  it('excludes the deactivated author\'s event and includes the active one', async () => {
    const res = await SELF.fetch('https://x/api/feed', { headers: { Cookie: `session=${memberTok}` } })
    const body = await res.json<{ events: Array<{ type: string }>; total: number }>()
    expect(body.events.map((e) => e.type)).toEqual(['comment_added'])
    expect(body.total).toBe(1)
  })

  it('reactivating the author restores the event', async () => {
    await getDb(env.DB).update(users).set({ deactivatedAt: null }).where(eq(users.id, goneId))
    const res = await SELF.fetch('https://x/api/feed', { headers: { Cookie: `session=${memberTok}` } })
    const body = await res.json<{ events: Array<{ type: string }>; total: number }>()
    expect(body.total).toBe(2)
    expect(body.events.map((e) => e.type).sort()).toEqual(['comment_added', 'priority_set'])
  })
})

describe('/api/feed nav-dot signal (latestEventAt) excludes deactivated authors', () => {
  it('does not light the nav dot for a deactivated author\'s event; reactivation restores it', async () => {
    await resetDb(); await applyMigrations()
    const viewer = await seedUser({ email: 'viewer@x.com' })
    const viewerTok = await seedSession(viewer)
    const gone = await seedUser({ email: 'gone2@x.com', deactivatedAt: new Date().toISOString() })
    const priorityBill = await seedBill({ billNumber: 'HB 9', title: 'Nav dot bill', priority: 'high' })
    const db = getDb(env.DB)
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'comment_added', billId: priorityBill, userId: gone,
      metadata: '{}', createdAt: '2026-05-05T10:00:00Z',
    })

    const res = await SELF.fetch('https://x/api/feed', { headers: { Cookie: `session=${viewerTok}` } })
    const body = await res.json<{ latestEventAt: string | null }>()
    expect(body.latestEventAt).toBeNull()

    await db.update(users).set({ deactivatedAt: null }).where(eq(users.id, gone))
    const res2 = await SELF.fetch('https://x/api/feed', { headers: { Cookie: `session=${viewerTok}` } })
    const body2 = await res2.json<{ latestEventAt: string | null }>()
    expect(body2.latestEventAt).toBe('2026-05-05 10:00:00')
  })
})

describe('runDigest excludes feed events authored by a deactivated member', () => {
  async function enableModule(db: ReturnType<typeof getDb>) {
    const v = JSON.stringify({ 'email-digest': true })
    await db.insert(associationConfig).values({ key: 'modules', value: v })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: v } })
  }

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
  })

  it('sends nothing when the sole qualifying event was authored by a deactivated member', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const recipient = await seedUser({ email: 'r1@e.com' }); await seedSession(recipient)
    const gone = await seedUser({ email: 'gone3@e.com', deactivatedAt: new Date().toISOString() })
    const billId = await seedBill({ billNumber: 'H 3', title: 'Digest bill', priority: 'high' })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'position_set', billId, userId: gone,
      metadata: JSON.stringify({ position: 'Support' }),
    })
    const f = vi.fn(); vi.stubGlobal('fetch', f)
    const result = await runDigest(env as any, db)
    expect(f).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, recipients: 0, sent: 0, failed: 0 })
  })

  it('reactivating the author includes the event in the next digest', async () => {
    const db = getDb(env.DB); await enableModule(db)
    const recipient = await seedUser({ email: 'r2@e.com' }); await seedSession(recipient)
    const gone = await seedUser({ email: 'gone4@e.com', deactivatedAt: new Date().toISOString() })
    const billId = await seedBill({ billNumber: 'H 4', title: 'Digest bill 2', priority: 'high' })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'position_set', billId, userId: gone,
      metadata: JSON.stringify({ position: 'Support' }),
    })
    await db.update(users).set({ deactivatedAt: null }).where(eq(users.id, gone))

    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))
    const result = await runDigest(env as any, db)
    expect(calls).toHaveLength(1)
    expect(result).toEqual({ ok: true, recipients: 1, sent: 1, failed: 0 })
  })
})

describe('bill detail hides priority attribution set by a deactivated member', () => {
  it('priorityMeta is null while the setter is deactivated and restored on reactivation; bill.priority is unaffected', async () => {
    await resetDb(); await applyMigrations()
    const adminTok = await seedSession(await seedUser({ role: 'admin', email: 'admin@x.com' }))
    const gone = await seedUser({ role: 'member', email: 'gone5@x.com', name: 'Gone Setter', deactivatedAt: new Date().toISOString() })
    const billId = await seedBill({ matchType: 'keyword', title: 'Priority bill', priority: 'high' })
    const db = getDb(env.DB)
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'priority_set', billId, userId: gone, metadata: '{}',
      createdAt: '2026-01-01T09:00:00Z',
    })

    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<{ priority: string | null; priorityMeta: { setByName: string; updatedAt: string } | null }>()
    expect(body.priority).toBe('high')
    expect(body.priorityMeta).toBeNull()

    await db.update(users).set({ deactivatedAt: null }).where(eq(users.id, gone))
    const res2 = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const body2 = await res2.json<{ priority: string | null; priorityMeta: { setByName: string; updatedAt: string } | null }>()
    expect(body2.priority).toBe('high')
    expect(body2.priorityMeta).toEqual({ setByName: 'Gone Setter', updatedAt: '2026-01-01T09:00:00Z' })
  })
})
