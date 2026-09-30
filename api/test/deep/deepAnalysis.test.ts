import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, calendarEventBills, deepAnalyses } from '../../src/db/schema'
import { app } from '../../src/index'
import { ensureDeepRequest, fireDeepWorker, reconcileDeepRequests } from '../../src/lib/deepAnalysis'

const TOKEN = 'worker-test-token'
const deepEnv = { ...env, DEEP_ANALYSIS_ENABLED: 'true', DEEP_WORKER_TOKEN: TOKEN, CENTRAL_API_URL: 'https://central.test' }
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

const BILL_CONTENT = {
  bottomLine: 'Raises the age for adult prosecution review.',
  whatChanges: [{ section: 'Sec. 2', change: 'Amends D.C. Code 16-2307', quote: 'shall not' }],
  whoItAffects: ['Youth charged as adults'],
  howItFits: ['Interacts with Secure DC (check)'],
  openQuestions: ['Who funds the review?'],
  testimony: { questions: ['How many youth?'], amendments: ['Add reporting'] },
  caveats: [],
}

async function call(path: string, init: RequestInit = {}, e: Record<string, unknown> = deepEnv) {
  const ctx = createExecutionContext()
  const res = await app.request(path, init, e, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
const asWorker = (method: string, body?: unknown, token = TOKEN): RequestInit => ({
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})

let high: string, medium: string, low: string, noText: string, adminCookie: string, memberCookie: string
beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ type: 'html', content: '<p>Sec. 2. The Code is amended.</p>' }), { status: 200 })))
  const db = getDb(env.DB)
  high = await seedBill({ billNumber: 'B26-0100', state: 'DC', priority: 'high', externalId: 'legiscan:1012600100' })
  medium = await seedBill({ billNumber: 'B26-0101', state: 'DC', priority: 'medium', externalId: 'legiscan:1012600101' })
  low = await seedBill({ billNumber: 'B26-0102', state: 'DC', priority: 'low', externalId: 'legiscan:1012600102' })
  noText = await seedBill({ billNumber: 'B26-0103', state: 'DC', priority: 'high', externalId: 'legiscan:1012600103' })
  await db.update(bills).set({ lastAiTextHash: 'text-v1' }).where(eq(bills.id, high))
  await db.update(bills).set({ lastAiTextHash: 'text-v1' }).where(eq(bills.id, medium))
  await db.update(bills).set({ lastAiTextHash: 'text-v1' }).where(eq(bills.id, low))
  adminCookie = `session=${await seedSession(await seedUser({ role: 'admin', email: 'a@example.com' }))}`
  memberCookie = `session=${await seedSession(await seedUser({ role: 'member', email: 'm@example.com' }))}`
})

describe('deep-analysis requests', () => {
  it('does nothing when the operator has not turned it on', async () => {
    expect(await reconcileDeepRequests(env as any, getDb(env.DB))).toBeNull()
  })

  it('requests high and medium bills with text, and briefs for Council events in the next 10 days', async () => {
    const soon = await seedCalendarEvent(high, { source: 'council', uid: 'council-1@x', date: day(3), eventHash: 'e1' })
    await getDb(env.DB).update((await import('../../src/db/schema')).calendarEvents).set({ billId: null }).where(eq((await import('../../src/db/schema')).calendarEvents.id, soon))
    await getDb(env.DB).insert(calendarEventBills).values({ eventId: soon, billId: high })
    await seedCalendarEvent(high, { source: 'council', uid: 'council-2@x', date: day(30), eventHash: 'e2' })
    await seedCalendarEvent(high, { source: 'hearing', uid: 'h@x', date: day(2), eventHash: 'e3' })
    expect(await reconcileDeepRequests(deepEnv as any, getDb(env.DB))).toEqual({ bills: 2, hearings: 1, withdrawn: 0 })
    const rows = await getDb(env.DB).select().from(deepAnalyses).all()
    expect(rows.map(r => [r.kind, r.subjectId]).sort()).toEqual([['bill', high], ['bill', medium], ['hearing', soon]].sort())
    // Idempotent.
    expect(await reconcileDeepRequests(deepEnv as any, getDb(env.DB))).toEqual({ bills: 0, hearings: 0, withdrawn: 0 })
    expect(rows.some(r => r.subjectId === low || r.subjectId === noText)).toBe(false)
  })

  it('puts a done analysis back to pending when the text changes, keeping the old content marked stale', async () => {
    const db = getDb(env.DB)
    await ensureDeepRequest(db, 'bill', high)
    const row = (await db.select().from(deepAnalyses).get())!
    await db.update(deepAnalyses).set({ status: 'done', content: JSON.stringify(BILL_CONTENT), contentInputHash: row.inputHash }).where(eq(deepAnalyses.id, row.id))
    expect(await ensureDeepRequest(db, 'bill', high)).toEqual({ status: 'done', changed: false })
    await db.update(bills).set({ lastAiTextHash: 'text-v2' }).where(eq(bills.id, high))
    expect(await ensureDeepRequest(db, 'bill', high)).toEqual({ status: 'pending', changed: true })
    const view = await (await call(`/api/deep/bill/${high}`, { headers: { Cookie: memberCookie } })).json() as any
    expect(view).toMatchObject({ status: 'pending', stale: true, content: { bottomLine: BILL_CONTENT.bottomLine } })
  })

  it('setting a priority requests a deep analysis', async () => {
    const res = await call(`/api/bills/${low}/priority`, { method: 'PATCH', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: 'high' }) })
    expect(res.status).toBe(200)
    const rows = await getDb(env.DB).select().from(deepAnalyses).all()
    expect(rows.map(r => r.subjectId)).toEqual([low])
  })

  it('lets admins request one by hand, and members only read', async () => {
    expect((await call(`/api/deep/bill/${low}/request`, { method: 'POST', headers: { Cookie: memberCookie } })).status).toBe(403)
    const res = await call(`/api/deep/bill/${low}/request`, { method: 'POST', headers: { Cookie: adminCookie } })
    expect(res.status).toBe(200)
    expect((await res.json() as any).status).toBe('pending')
  })
})

describe('deep-analysis worker', () => {
  it('is hidden when off and refuses a wrong token', async () => {
    expect((await call('/api/deep/worker/requests', asWorker('GET'), { ...env })).status).toBe(404)
    expect((await call('/api/deep/worker/requests', asWorker('GET', undefined, 'nope'))).status).toBe(401)
  })

  it('lists, claims, fetches input, and posts a validated result', async () => {
    await ensureDeepRequest(getDb(env.DB), 'bill', high)
    const list = await (await call('/api/deep/worker/requests', asWorker('GET'))).json() as any
    expect(list.requests).toHaveLength(1)
    const req = list.requests[0]

    const claim = await call(`/api/deep/worker/requests/${req.id}/claim`, asWorker('POST', { worker: 'test' }))
    expect(claim.status).toBe(200)
    const input = await claim.json() as any
    expect(input.instructions).toMatch(/deep analysis/)
    expect(input.bill.number).toBe('B26-0100')
    expect(input.text).toEqual({ available: true, path: `/api/deep/worker/requests/${req.id}/text` })
    const text = await call(input.text.path, asWorker('GET'))
    expect(text.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await text.text()).toBe('Sec. 2. The Code is amended.')
    // Claimed within the lease: not offered again.
    expect((await call(`/api/deep/worker/requests/${req.id}/claim`, asWorker('POST'))).status).toBe(409)
    expect(((await (await call('/api/deep/worker/requests', asWorker('GET'))).json()) as any).requests).toHaveLength(0)

    const bad = await call(`/api/deep/worker/requests/${req.id}/result`, asWorker('POST', { inputHash: input.inputHash, content: { whatChanges: 'x' } }))
    expect(bad.status).toBe(400)
    expect((await bad.json() as any).error).toMatch(/bottomLine is required/)
    const wrongHash = await call(`/api/deep/worker/requests/${req.id}/result`, asWorker('POST', { inputHash: 'old', content: BILL_CONTENT }))
    expect(wrongHash.status).toBe(409)

    const ok = await call(`/api/deep/worker/requests/${req.id}/result`, asWorker('POST', { inputHash: input.inputHash, model: 'claude-opus-5-5', content: BILL_CONTENT }))
    expect(ok.status).toBe(200)
    const view = await (await call(`/api/deep/bill/${high}`, { headers: { Cookie: memberCookie } })).json() as any
    expect(view).toMatchObject({ enabled: true, status: 'done', stale: false, model: 'claude-opus-5-5', content: BILL_CONTENT })
  })

  it('serves a hearing brief input with the linked bills and their analyses', async () => {
    const db = getDb(env.DB)
    const ev = await seedCalendarEvent(high, { source: 'council', uid: 'council-9@x', date: day(4), description: 'Youth Affairs roundtable: DYRS', eventHash: 'e9' })
    await ensureDeepRequest(db, 'bill', high)
    const billRow = (await db.select().from(deepAnalyses).get())!
    await db.update(deepAnalyses).set({ status: 'done', content: JSON.stringify(BILL_CONTENT), contentInputHash: billRow.inputHash }).where(eq(deepAnalyses.id, billRow.id))
    await ensureDeepRequest(db, 'hearing', ev)
    const hearing = (await db.select().from(deepAnalyses).where(eq(deepAnalyses.kind, 'hearing')).get())!
    const input = await (await call(`/api/deep/worker/requests/${hearing.id}/claim`, asWorker('POST'))).json() as any
    expect(input.instructions).toMatch(/brief/)
    expect(input.event.title).toBe('Youth Affairs roundtable: DYRS')
    expect(input.bills).toEqual([expect.objectContaining({ number: 'B26-0100', deepAnalysis: BILL_CONTENT })])
  })
})

describe('starting the worker', () => {
  const fireEnv = { ...deepEnv, DEEP_WORKER_FIRE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_01X/fire', DEEP_WORKER_FIRE_TOKEN: 'fire-token' }

  it('fires only when requests are waiting, with the routine headers, at most once an hour', async () => {
    const db = getDb(env.DB)
    expect(await fireDeepWorker(fireEnv as any, db)).toBe(false)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    await ensureDeepRequest(db, 'bill', high)
    expect(await fireDeepWorker(fireEnv as any, db)).toBe(true)
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(fireEnv.DEEP_WORKER_FIRE_URL)
    expect(init.headers).toMatchObject({ Authorization: 'Bearer fire-token', 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01' })
    expect(JSON.parse(String(init.body))).toEqual({ text: 'FloorVote has 1 deep-analysis request waiting.' })
    expect(await fireDeepWorker(fireEnv as any, db)).toBe(false)
    expect(await fireDeepWorker(fireEnv as any, db, { manual: true })).toBe(false)
  })

  it('does nothing without a fire URL', async () => {
    await ensureDeepRequest(getDb(env.DB), 'bill', high)
    expect(await fireDeepWorker(deepEnv as any, getDb(env.DB))).toBe(false)
  })
})

