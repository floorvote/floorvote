import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'

// A stub bill's detail refreshed in the background when its page is viewed and
// the detail is stale (lib/stubRefresh.ts, GET /bills/:id?view=1).

// getBill is the metered call a refresh spends. Mocked, so no test reaches
// api.legiscan.com, and so a test can land a refresh by running the ingest.
vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return { ...actual, getBill: vi.fn(), getBillText: vi.fn() }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { app, TenantApi } from '../../src/index'
import { processIngestorQueue } from '../../src/queue/processor'
import * as legiscan from '../../src/providers/legiscan/client'
import { clearDb } from '../helpers/migrations'

const STUB = 700
const AUTH = { 'x-admin-secret': 'test-secret' }

beforeEach(async () => {
  await clearDb()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
  vi.mocked(legiscan.getBill).mockReset()
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({
    sessionId: 2154, state: 'WI', stateId: 50, yearStart: 2025, yearEnd: 2026, sessionName: '2025-2026 Regular', sessionTitle: 'Regular',
  })
  await db.insert(schema.tenants).values([
    { tenantId: 'a', name: 'A', stateCoverage: '["WI"]', active: true } as any,
    { tenantId: 'b', name: 'B', stateCoverage: '["WI"]', active: true } as any,
  ])
  await seedStub(STUB)
})

/** A stub: a LegiScan bill linked to two instances, neither tracking it, whose detail is older than its last action. */
async function seedStub(billId: number, over: Partial<typeof schema.bills.$inferInsert> = {}, links: Record<string, 'keyword' | 'manual' | null> = { a: null, b: null }) {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.bills).values({
    billId, sessionId: 2154, state: 'WI', stateId: 50, billNumber: `AB${billId}`, title: `Bill ${billId}`,
    changeHash: 'h1', status: 2, lastAction: 'Passed Assembly', lastActionDate: '2026-04-01', ...over,
  })
  await db.insert(schema.billHistory).values({ id: crypto.randomUUID(), billId, date: '2026-01-15', action: 'Introduced', importance: 1, seq: 0 })
  for (const [tenantId, matchType] of Object.entries(links)) {
    await db.insert(schema.billTenants).values({ billId, tenantId, matchType })
  }
}

/** An env whose ingestor queue records what is sent to it. */
function queueEnv(send: (body: any) => Promise<void> = async () => {}) {
  const sent: any[] = []
  const queue = {
    send: async (body: any) => { await send(body); sent.push(body) },
    sendBatch: async (msgs: { body: any }[]) => { for (const m of msgs) { await send(m.body); sent.push(m.body) } },
  }
  return { env2: { ...env, INGESTOR_QUEUE: queue } as any, sent }
}

/** A context that collects waitUntil work, so a test can wait for it after the response. */
function execCtx(props: Record<string, unknown> = {}) {
  const pending: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => {}, props } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  }
}

/** Open the bill's page: the view an instance's bill page makes. */
async function view(billId: number, env2: any, opts: { flag?: boolean } = {}) {
  const { ctx, settle } = execCtx()
  const res = await app.request(`/api/bills/legiscan:${billId}${opts.flag === false ? '' : '?view=1'}`, { headers: AUTH }, env2, ctx)
  expect(res.status).toBe(200)
  const body = await res.json() as any
  await settle()
  return body
}

/** The fetch a refresh queues, landed: the ingest that runs getBill and writes the bill's detail. */
async function land(billId: number, measure: Record<string, unknown>, body: Record<string, unknown> = { billId }) {
  vi.mocked(legiscan.getBill).mockResolvedValueOnce({
    bill_id: billId, change_hash: 'h1', session_id: 2154, state: 'WI', state_id: 50, bill_number: `AB${billId}`,
    bill_type: 'B', bill_type_id: '1', body: 'A', body_id: 26, current_body: 'S', current_body_id: 27,
    title: `Bill ${billId}`, description: '', status: 2, status_date: '2026-04-01', completed: 0,
    pending_committee_id: 7001, url: '', state_link: '',
    session: { session_id: 2154, session_name: '2025-2026 Regular', year_start: 2025, year_end: 2026 },
    committee: { committee_id: 7001, chamber: 'S', chamber_id: 27, name: 'Elections' },
    referrals: [{ date: '2026-04-02', committee_id: 7001, chamber: 'S', chamber_id: 27, name: 'Elections' }],
    progress: [], sponsors: [], sasts: [], subjects: [], votes: [], texts: [], calendar: [], amendments: [], supplements: [],
    history: [
      { date: '2026-01-15', action: 'Introduced', chamber: 'A', chamber_id: 26, importance: 1 },
      { date: '2026-03-10', action: 'Reported out of committee', chamber: 'A', chamber_id: 26, importance: 1 },
      { date: '2026-04-01', action: 'Passed Assembly', chamber: 'A', chamber_id: 26, importance: 1 },
    ],
    ...measure,
  } as any)
  const ack = vi.fn()
  const retry = vi.fn()
  await processIngestorQueue({
    messages: [{ body, ack, retry, id: 'm', timestamp: new Date(), attempts: 1 }],
    queue: 'central-legiscan-ingestor', ackAll: vi.fn(), retryAll: vi.fn(),
  } as unknown as MessageBatch<any>, env as any, drizzle(env.DB, { schema }))
  expect(ack).toHaveBeenCalled()
}

/** What the master-list sync does to a stub that changed: a new change hash and last action, no detail. */
async function masterListChange(billId: number, hash: string) {
  await env.DB.prepare(`UPDATE bills SET change_hash = ?, last_action = 'Read first time in Senate', last_action_date = '2026-05-01' WHERE bill_id = ?`)
    .bind(hash, billId).run()
}

describe('a view of a stale stub', () => {
  it('queues one detail fetch for the bill', async () => {
    const { env2, sent } = queueEnv()
    await view(STUB, env2)
    expect(sent).toEqual([{ billId: STUB, queuedBy: 'legiscan' }])
  })

  it('answers without waiting for the fetch to be queued', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const { env2, sent } = queueEnv(() => gate)
    const { ctx, settle } = execCtx()
    const answered = await Promise.race([
      app.request(`/api/bills/legiscan:${STUB}?view=1`, { headers: AUTH }, env2, ctx).then(r => r.status),
      new Promise(r => setTimeout(() => r('still waiting'), 2000)),
    ])
    expect(answered).toBe(200)
    expect(sent).toHaveLength(0)
    release()
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('serves the stale detail until the fetch lands, then the refreshed actions and committee', async () => {
    const { env2, sent } = queueEnv()
    const before = await view(STUB, env2)
    // The honest gap: the last action is newer than the one action held, and no committee is named.
    expect(before.actions.map((a: any) => a.description)).toEqual(['Introduced'])
    expect(before.lastActionDate).toBe('2026-04-01')
    expect(before.committee).toBeNull()

    // The message the view queued, run by the ingestor.
    expect(sent).toHaveLength(1)
    await land(STUB, {}, sent[0])
    expect(legiscan.getBill).toHaveBeenCalledTimes(1)
    const after = await view(STUB, env2)
    expect(after.actions.map((a: any) => a.description)).toEqual(['Introduced', 'Reported out of committee', 'Passed Assembly'])
    expect(after.committee).toMatchObject({ name: 'Elections', chamber: 'S' })
  })

  it('queues nothing more once the fetch has landed, until the bill changes again', async () => {
    const { env2, sent } = queueEnv()
    await view(STUB, env2)
    await land(STUB, {})
    await view(STUB, env2)
    await view(STUB, env2)
    expect(sent).toHaveLength(1)

    await masterListChange(STUB, 'h2')
    await view(STUB, env2)
    await view(STUB, env2)
    expect(sent).toHaveLength(2)
  })
})

describe('the detail marker', () => {
  it('records the change each ingest fetched the detail at, apart from the change hash the sync moves', async () => {
    const marker = async () => {
      const r = await env.DB.prepare('SELECT * FROM bills WHERE bill_id = ?').bind(STUB).first<Record<string, unknown>>()
      return { change_hash: r!.change_hash, detail_hash: r!.detail_hash }
    }
    expect(await marker()).toEqual({ change_hash: 'h1', detail_hash: null })
    await land(STUB, { change_hash: 'h1' })
    expect(await marker()).toEqual({ change_hash: 'h1', detail_hash: 'h1' })
    await masterListChange(STUB, 'h2')
    expect(await marker()).toEqual({ change_hash: 'h2', detail_hash: 'h1' })
    await land(STUB, { change_hash: 'h2' })
    expect(await marker()).toEqual({ change_hash: 'h2', detail_hash: 'h2' })
  })
})

describe('at most once per change to the bill', () => {
  it('queues nothing from repeat views before the fetch lands', async () => {
    const { env2, sent } = queueEnv()
    await view(STUB, env2)
    await view(STUB, env2)
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
  })

  it('queues one fetch from concurrent views', async () => {
    const { env2, sent } = queueEnv()
    await Promise.all(Array.from({ length: 5 }, () => view(STUB, env2)))
    expect(sent).toHaveLength(1)
  })

  it('queues one fetch from views by two instances over their bindings', async () => {
    const { env2, sent } = queueEnv()
    const env3 = { ...env2, ADMIN_SECRET: 'test-secret' }
    for (const tenantId of ['a', 'b']) {
      const { ctx, settle } = execCtx({ tenantId })
      const res = await new TenantApi(ctx, env3).fetch(new Request(`https://central/api/bills/legiscan:${STUB}?view=1`))
      expect(res.status).toBe(200)
      await settle()
    }
    expect(sent).toHaveLength(1)
  })

  it('queues one more fetch when the bill changes before the first lands', async () => {
    const { env2, sent } = queueEnv()
    await view(STUB, env2)
    await masterListChange(STUB, 'h2')
    await view(STUB, env2)
    await view(STUB, env2)
    expect(sent).toHaveLength(2)
  })

  it('queues nothing from a current stub, then one fetch once it goes stale', async () => {
    const { env2, sent } = queueEnv()
    // The detail was fetched at the change the bill is at.
    await land(STUB, {})
    await view(STUB, env2)
    expect(sent).toHaveLength(0)
    await masterListChange(STUB, 'h2')
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
  })
})

describe('a refresh that never lands', () => {
  it('is not queued again within the retry window, and is queued again once it passes', async () => {
    const { env2, sent } = queueEnv()
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
    // The fetch failed: the detail is still stale, and the claim stands.
    await env.DB.prepare(`UPDATE bills SET detail_requested_at = datetime('now', '-1 hours') WHERE bill_id = ?`).bind(STUB).run()
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
    await env.DB.prepare(`UPDATE bills SET detail_requested_at = datetime('now', '-25 hours') WHERE bill_id = ?`).bind(STUB).run()
    await view(STUB, env2)
    await view(STUB, env2)
    expect(sent).toHaveLength(2)
  })

  it('is queued by the next view when the queue refused it', async () => {
    let fail = true
    const { env2, sent } = queueEnv(async () => { if (fail) { fail = false; throw new Error('queue down') } })
    await view(STUB, env2)
    expect(sent).toHaveLength(0)
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
  })
})

describe('bills this path never refreshes', () => {
  it('queues nothing for a bill an instance tracks by keyword or by hand', async () => {
    await seedStub(701, {}, { a: 'keyword', b: null })
    await seedStub(702, {}, { a: null, b: 'manual' })
    const { env2, sent } = queueEnv()
    await view(701, env2)
    await view(702, env2)
    await view(STUB, env2)
    expect(sent).toEqual([{ billId: STUB, queuedBy: 'legiscan' }])
  })

  it("queues nothing for another provider's bill", async () => {
    await seedStub(703, { provider: 'lims' })
    await seedStub(704, { provider: 'mga' })
    const { env2, sent } = queueEnv()
    await view(703, env2)
    await view(704, env2)
    await view(STUB, env2)
    expect(sent).toEqual([{ billId: STUB, queuedBy: 'legiscan' }])
  })

  it('queues nothing from a read that is not a page view, such as an instance storing a delivery', async () => {
    const { env2, sent } = queueEnv()
    await view(STUB, env2, { flag: false })
    expect(sent).toHaveLength(0)
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
  })
})

describe('the budget floor', () => {
  async function setLimit(n: number) {
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('legiscan_monthly_limit', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(String(n)).run()
  }
  async function logCalls(n: number, callType = 'getBill') {
    await env.DB.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
      INSERT INTO api_call_log (logged_at, call_type, params) SELECT datetime('now'), ?, '{}' FROM k`).bind(n, callType).run()
  }

  it('queues a fetch while the calls left stay above the floor', async () => {
    // A limit of 100 has a floor of 25: 74 used leaves 26, and a fetch leaves 25.
    await setLimit(100)
    await logCalls(74)
    const { env2, sent } = queueEnv()
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
  })

  it('queues nothing, and keeps the stale detail, once the calls left reach the floor', async () => {
    await setLimit(100)
    await logCalls(75)
    const { env2, sent } = queueEnv()
    const body = await view(STUB, env2)
    expect(sent).toHaveLength(0)
    expect(body.actions.map((a: any) => a.description)).toEqual(['Introduced'])
    expect(body.committee).toBeNull()
    // Nothing was claimed: a view after the budget recovers (a higher limit, a new month) queues the fetch.
    await setLimit(1000)
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
  })

  it("doesn't count other providers' calls against the floor", async () => {
    await setLimit(100)
    await logCalls(74)
    await logCalls(50, 'lims:Members')
    const { env2, sent } = queueEnv()
    await view(STUB, env2)
    expect(sent).toHaveLength(1)
  })

  it('counts fetches already queued and not yet landed, so a burst of concurrent views stops at the floor', async () => {
    // A limit of 8 has a floor of 2: six fetches may be queued before any is logged, and no more.
    await setLimit(8)
    for (let id = 801; id <= 807; id++) await seedStub(id)
    const { env2, sent } = queueEnv()
    await Promise.all(Array.from({ length: 7 }, (_, i) => view(801 + i, env2)))
    expect(sent).toHaveLength(6)
  })

  it('stops exactly at the floor when the views come one after another', async () => {
    await setLimit(8)
    for (let id = 801; id <= 807; id++) await seedStub(id)
    const { env2, sent } = queueEnv()
    for (let id = 801; id <= 807; id++) await view(id, env2)
    expect(sent.map(m => m.billId)).toEqual([801, 802, 803, 804, 805, 806])
  })
})

describe('a bill the bulk seed wrote', () => {
  // scripts/seed-legiscan.ts writes a session's bills, detail and all, from the
  // bulk dataset, then queues them with skipFetch, which never reaches the ingest.
  it('queues no refresh from its first view, and one once the sync moves it on', async () => {
    const { buildBillStatements } = await import('../../../scripts/lib/build-bill-statements')
    const seeded = {
      bill_id: 710, change_hash: 'seed-h1', session_id: 2154, state: 'WI', state_id: 50, bill_number: 'AB710',
      title: 'Seeded bill', status: 2, status_date: '2026-04-01',
      history: [
        { date: '2026-01-15', action: 'Introduced', chamber: 'A', chamber_id: 26, importance: 1 },
        { date: '2026-04-01', action: 'Passed Assembly', chamber: 'A', chamber_id: 26, importance: 1 },
      ],
    }
    for (const s of buildBillStatements(seeded, 'WI', 2154)) await env.DB.prepare(s).run()
    await env.DB.prepare(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) VALUES (710, 'a', NULL)`).run()

    const { env2, sent } = queueEnv()
    await view(710, env2)
    expect(sent).toHaveLength(0)
    await masterListChange(710, 'seed-h2')
    await view(710, env2)
    expect(sent).toEqual([{ billId: 710, queuedBy: 'legiscan' }])
  })
})
