// Regressions for the adversarial review of the deep-analysis queue (d2f0cef).
// Each test started as the reviewer's reproduction of a bug and now asserts the fix.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, calendarEventBills, calendarEvents, deepAnalyses } from '../../src/db/schema'
import { app } from '../../src/index'
import { ensureDeepRequest, listOpenRequests, reconcileDeepRequests } from '../../src/lib/deepAnalysis'

const TOKEN = 'worker-test-token'
const deepEnv = { ...env, DEEP_ANALYSIS_ENABLED: 'true', DEEP_WORKER_TOKEN: TOKEN, CENTRAL_API_URL: 'https://central.test' }
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const dbTs = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ')

const BILL_CONTENT = {
  bottomLine: 'x', whatChanges: [], whoItAffects: [], howItFits: [], openQuestions: [],
  testimony: { questions: [], amendments: [] }, caveats: [],
}

async function call(path: string, init: RequestInit = {}, e: Record<string, unknown> = deepEnv) {
  const ctx = createExecutionContext()
  const res = await app.request(path, init, e, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
const asWorker = (method: string, body?: unknown): RequestInit => ({
  method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

let high: string, adminCookie: string
beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ type: 'html', content: '<p>Sec. 2.</p>' }), { status: 200 })))
  high = await seedBill({ billNumber: 'B26-0100', state: 'DC', priority: 'high', externalId: 'legiscan:1' })
  await getDb(env.DB).update(bills).set({ lastAiTextHash: 'text-v1' }).where(eq(bills.id, high))
  adminCookie = `session=${await seedSession(await seedUser({ role: 'admin', email: 'a@example.com' }))}`
})

describe('review: queue state machine', () => {
  it('clearing a priority withdraws the waiting request', async () => {
    await ensureDeepRequest(getDb(env.DB), 'bill', high)
    const res = await call(`/api/bills/${high}/priority`, { method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: null }) })
    expect(res.status).toBe(200)
    expect(((await (await call('/api/deep/worker/requests', asWorker('GET'))).json()) as any).requests).toEqual([])
    expect(await getDb(env.DB).select().from(deepAnalyses).all()).toEqual([])
  })

  it('withdrawing a request that has earlier content returns it to that content, not stale', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    await db.update(deepAnalyses).set({ status: 'done', content: JSON.stringify(BILL_CONTENT), contentInputHash: row.inputHash }).where(eq(deepAnalyses.id, row.id))
    await db.update(bills).set({ lastAiTextHash: 'text-v2' }).where(eq(bills.id, high))
    await reconcileDeepRequests(deepEnv as any, db)
    expect((await db.select().from(deepAnalyses).get())!.status).toBe('pending')
    await db.update(bills).set({ priority: 'low' }).where(eq(bills.id, high))
    await reconcileDeepRequests(deepEnv as any, db)
    const view = await (await call(`/api/deep/bill/${high}`, { headers: { Cookie: adminCookie } })).json() as any
    expect(view).toMatchObject({ status: 'done', stale: false, content: BILL_CONTENT })
  })

  it('a text download that fails hands the request back; nothing is written without the text', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    const input = await (await call(`/api/deep/worker/requests/${row.id}/claim`, asWorker('POST'))).json() as any
    vi.mocked(fetch).mockImplementation(async () => new Response('upstream down', { status: 503 }))
    expect((await call(input.text.path, asWorker('GET'))).status).toBe(503)
    expect((await call(`/api/deep/worker/requests/${row.id}/release`, asWorker('POST', { inputHash: input.inputHash }))).status).toBe(200)
    expect(await listOpenRequests(db)).toHaveLength(1)
  })

  it('a failed request is offered again after a wait, and not after its attempts run out', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    await call(`/api/deep/worker/requests/${row.id}/claim`, asWorker('POST'))
    await call(`/api/deep/worker/requests/${row.id}/result`, asWorker('POST', { inputHash: row.inputHash, error: 'rate limited' }))
    await reconcileDeepRequests(deepEnv as any, db)
    expect((await db.select().from(deepAnalyses).get())!.status).toBe('error')
    await db.update(deepAnalyses).set({ completedAt: dbTs(7 * 3_600_000) }).where(eq(deepAnalyses.id, row.id))
    await reconcileDeepRequests(deepEnv as any, db)
    expect(await listOpenRequests(db)).toHaveLength(1)
    await db.update(deepAnalyses).set({ attempts: 3 }).where(eq(deepAnalyses.id, row.id))
    expect(await listOpenRequests(db)).toHaveLength(0)
  })

  it('a request whose claims keep lapsing is marked failed after three attempts', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    await db.update(deepAnalyses).set({ status: 'claimed', attempts: 3, claimedAt: dbTs(61 * 60_000) }).where(eq(deepAnalyses.id, row.id))
    await reconcileDeepRequests(deepEnv as any, db)
    expect((await db.select().from(deepAnalyses).get())).toMatchObject({ status: 'error', error: 'Gave up after 3 attempts.' })
  })

  it('an input change between the result handler\'s read and write leaves the new request pending', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    await call(`/api/deep/worker/requests/${row.id}/claim`, asWorker('POST'))
    let armed = true
    const hook = async () => { await db.update(bills).set({ lastAiTextHash: 'text-v2' }).where(eq(bills.id, high)); await ensureDeepRequest(db, 'bill', high) }
    const wrapStmt = (stmt: any, sqlText: string): any => new Proxy(stmt, {
      get(t, p) {
        const v = t[p]
        if (p === 'bind') return (...a: unknown[]) => wrapStmt(v.apply(t, a), sqlText)
        if (['all', 'raw', 'first', 'run'].includes(p as string)) return async (...a: unknown[]) => {
          const r = await v.apply(t, a)
          if (armed && /^select .*from "deep_analyses" where "deep_analyses"."id" = \?/i.test(sqlText)) { armed = false; await hook() }
          return r
        }
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    const DB = new Proxy(env.DB, { get(t, p) { const v = (t as any)[p]; if (p === 'prepare') return (q: string) => wrapStmt(v.call(t, q), q); return typeof v === 'function' ? v.bind(t) : v } })
    const res = await call(`/api/deep/worker/requests/${row.id}/result`, asWorker('POST', { inputHash: row.inputHash, content: BILL_CONTENT }), { ...deepEnv, DB })
    expect(armed).toBe(false)
    expect(res.status).toBe(409)
    const after = (await db.select().from(deepAnalyses).get())!
    expect(after.status).toBe('pending')
    expect(after.content).toBeNull()
    expect(await listOpenRequests(db)).toHaveLength(1)
  })

  it('a result is refused for a request that was never claimed', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    expect((await call(`/api/deep/worker/requests/${row.id}/result`, asWorker('POST', { inputHash: row.inputHash, content: BILL_CONTENT }))).status).toBe(409)
  })

  it('any open request can be claimed, however many are waiting', async () => {
    const db = getDb(env.DB)
    await db.delete(deepAnalyses)
    const ids: string[] = []
    for (let i = 0; i < 51; i++) {
      const b = await seedBill({ billNumber: `B26-${1000 + i}`, state: 'DC', priority: 'high' })
      await db.update(bills).set({ lastAiTextHash: 't' }).where(eq(bills.id, b))
      await ensureDeepRequest(db, 'bill', b)
      const r = (await db.select().from(deepAnalyses).where(eq(deepAnalyses.subjectId, b)).get())!
      await db.update(deepAnalyses).set({ requestedAt: dbTs((100 - i) * 60_000) }).where(eq(deepAnalyses.id, r.id))
      ids.push(r.id)
    }
    expect((await call(`/api/deep/worker/requests/${ids[50]}/claim`, asWorker('POST'))).status).toBe(200)
  })

  it('lease: claimed_at written by nowDb compares correctly against datetime(now, -60 minutes)', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    await db.update(deepAnalyses).set({ status: 'claimed', claimedAt: dbTs(59 * 60_000) }).where(eq(deepAnalyses.id, row.id))
    expect(await listOpenRequests(db)).toHaveLength(0)
    await db.update(deepAnalyses).set({ claimedAt: dbTs(61 * 60_000) }).where(eq(deepAnalyses.id, row.id))
    expect(await listOpenRequests(db)).toHaveLength(1)
    expect((await call(`/api/deep/worker/requests/${row.id}/claim`, asWorker('POST'))).status).toBe(200)
  })
})

describe('review: input bundle contents', () => {
  it('refuses hearing briefs for custom events, and never sends drafts', async () => {
    const db = getDb(env.DB)
    const draft = await seedBill({ billNumber: 'DRAFT-1', title: 'Unreleased draft', state: 'DC', isDraft: true, tenantSummary: 'internal draft summary' })
    const custom = await seedCalendarEvent(high, { source: 'custom', uid: 'c@x', date: day(3) })
    await db.update(calendarEvents).set({ billId: null, details: 'Prep call with family of client J.D.' }).where(eq(calendarEvents.id, custom))
    expect((await call(`/api/deep/hearing/${custom}/request`, { method: 'POST', headers: { Cookie: adminCookie } })).status).toBe(404)

    const council = await seedCalendarEvent(high, { source: 'council', uid: 'council-5@x', date: day(3) })
    await db.update(calendarEvents).set({ billId: null }).where(eq(calendarEvents.id, council))
    await db.insert(calendarEventBills).values([{ eventId: council, billId: draft }, { eventId: council, billId: high }])
    expect((await call(`/api/deep/hearing/${council}/request`, { method: 'POST', headers: { Cookie: adminCookie } })).status).toBe(200)
    const row = (await db.select().from(deepAnalyses).where(eq(deepAnalyses.kind, 'hearing')).get())!
    const input = await (await call(`/api/deep/worker/requests/${row.id}/claim`, asWorker('POST'))).json() as any
    expect(input.bills.map((b: any) => b.number)).toEqual(['B26-0100'])
  })
})

describe('review: D1 query budget', () => {
  it('an idempotent hourly sweep costs a fixed handful of statements, whatever the bill count', async () => {
    const db0 = getDb(env.DB)
    for (let i = 0; i < 40; i++) {
      const b = await seedBill({ billNumber: `B26-${2000 + i}`, state: 'DC', priority: 'medium' })
      await db0.update(bills).set({ lastAiTextHash: 't' }).where(eq(bills.id, b))
    }
    await reconcileDeepRequests(deepEnv as any, db0) // first pass creates rows
    let n = 0
    const counted = new Proxy(env.DB, {
      get(t, p) {
        const v = (t as any)[p]
        if (p === 'prepare') return (...a: unknown[]) => { n++; return v.apply(t, a) }
        if (p === 'batch') return (...a: any[]) => { n += a[0].length; return v.apply(t, a) }
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    await reconcileDeepRequests(deepEnv as any, getDb(counted as any))
    expect(n).toBeLessThanOrEqual(10)
  })
})
