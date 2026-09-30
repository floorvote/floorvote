// Review repros for e92e76d (team links + deep inputs). Each `it` asserts the
// CORRECT behaviour, so a failure is the bug.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { deepAnalyses, teamLinks } from '../../src/db/schema'
import { app } from '../../src/index'
import { ensureDeepRequest, listOpenRequests, reconcileDeepRequests } from '../../src/lib/deepAnalysis'
import { bills } from '../../src/db/schema'

const deepEnv = { ...env, DEEP_ANALYSIS_ENABLED: 'true', DEEP_WORKER_TOKEN: 't', CENTRAL_API_URL: 'https://central.test' }
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext()
  const res = await app.request(path, init, deepEnv, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

let bill: string, admin: string, adminId: string
beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ committees: [], people: [], byId: {} }), { status: 200 })))
  bill = await seedBill({ billNumber: 'B26-0001', state: 'DC', priority: 'high', externalId: 'legiscan:1012600001' })
  adminId = await seedUser({ role: 'admin', email: 'a@example.com' })
  admin = `session=${await seedSession(adminId)}`
})

describe('review: hearing link refresh', () => {
  it('adding a document to an admin-requested brief outside the 10-day window keeps the request (not withdrawn by the next sweep)', async () => {
    const db = getDb(env.DB)
    const ev = await seedCalendarEvent(bill, { source: 'council', uid: 'council-far@x', date: day(20) })
    // Admin asked for this brief (outside the auto window); it finished.
    await ensureDeepRequest(db, 'hearing', ev, { force: true, requestedBy: adminId })
    const r0 = (await db.select().from(deepAnalyses).where(eq(deepAnalyses.subjectId, ev)).get())!
    await db.update(deepAnalyses).set({ status: 'done', content: '{"overview":"old"}', contentInputHash: r0.inputHash }).where(eq(deepAnalyses.id, r0.id))

    const add = await call(`/api/links/event/${ev}`, {
      method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Redline', url: 'https://docs.google.com/d/9' }),
    })
    expect(add.status).toBe(201)
    const r1 = (await db.select().from(deepAnalyses).where(eq(deepAnalyses.subjectId, ev)).get())!
    expect(r1.status).toBe('pending')
    // BUG: ensureDeepRequest defaults requestedBy to 'auto'.
    expect.soft(r1.requestedBy).toBe(adminId)

    // The hourly sweep then withdraws it, because it is auto and outside the window.
    await reconcileDeepRequests(deepEnv as any, db)
    const r2 = (await db.select().from(deepAnalyses).where(eq(deepAnalyses.subjectId, ev)).get())!
    expect(r2.status).toBe('pending')
  })
})

describe('review: link rows follow their subject', () => {
  it('refuses links on draft bills, so a deleted draft leaves none behind', async () => {
    const draft = await seedBill({ billNumber: 'DRAFT-1', state: 'DC', isDraft: true } as any)
    const add = await call(`/api/links/bill/${draft}`, {
      method: 'POST', headers: { Cookie: admin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Letter', url: 'https://docs.google.com/d/1' }),
    })
    expect(add.status).toBe(404)
    const db = getDb(env.DB)
    expect(await db.select().from(teamLinks).where(and(eq(teamLinks.subjectKind, 'bill'), eq(teamLinks.subjectId, draft))).all()).toHaveLength(0)
  })
})

describe('deep queue order (review regression)', () => {
  it('after a mass re-request of bills, a hearing 3 days out is still in the first page the worker sees', async () => {
    const db = getDb(env.DB)
    for (let i = 0; i < 25; i++) {
      const id = await seedBill({ billNumber: `B26-1${String(i).padStart(3, '0')}`, state: 'DC', priority: 'medium', externalId: `legiscan:10126011${String(i).padStart(2, '0')}` })
      await db.update(bills).set({ lastAiTextHash: `t${i}` }).where(eq(bills.id, id))
    }
    const ev = await seedCalendarEvent(bill, { source: 'council', uid: 'council-soon@x', date: day(3) })
    await reconcileDeepRequests(deepEnv as any, db)  // what the first sweep after the v2 deploy does
    const page = await listOpenRequests(db, 20)       // GET /worker/requests default
    expect(page.map(r => r.subjectId)).toContain(ev)
  })
})
