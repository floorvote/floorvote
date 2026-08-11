import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { eq } from 'drizzle-orm'

const AUTH = { 'x-admin-secret': 'sek', 'content-type': 'application/json' }
const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => { await setupLsDb() })

async function seedReproc() {
  const db = drizzle(env.DB, { schema })
  // bills table: NOT NULL = changeHash, sessionId, state, stateId, billNumber, title, status
  await db.insert(schema.bills).values([
    { billId: 101, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'H1', title: 'A', changeHash: 'h1', status: 1 },
    { billId: 102, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'H2', title: 'B', changeHash: 'h2', status: 1 },
  ])
  // billTenants table: NOT NULL = billId, tenantId (via composite PK)
  await db.insert(schema.billTenants).values([
    { billId: 101, tenantId: 'ri', matchType: 'keyword' },
    { billId: 102, tenantId: 'ri', matchType: 'keyword' },
  ])
  // billCalendar table: NOT NULL = id, billId (rest nullable)
  await db.insert(schema.billCalendar).values([
    { id: 'c1', billId: 101, typeId: 1, type: 'Hearing', date: '2026-06-04', time: '14:00:00', location: 'R35', description: 'Cmte', eventHash: 'h1' },
  ])
}

function queueEnv() {
  const sent: any[] = []
  const env2: any = {
    ...TEST_ENV,
    TENANT_QUEUE_RI: {
      send: async (m: any) => sent.push(m),
      sendBatch: async (ms: any[]) => sent.push(...ms.map((x: any) => x.body)),
    },
  }
  return { env2, sent }
}

describe('POST /tenants/reprocess/:tenantId — targeted billIds', () => {
  it('queues only the listed bills, each with a calendar block', async () => {
    await seedReproc()
    const { env2, sent } = queueEnv()
    const res = await app.fetch(
      new Request('http://central/api/tenants/reprocess/ri', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ billIds: [101] }),
      }),
      env2,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.hasMore).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0].billId).toBe('legiscan:101')
    expect(sent[0].calendar).toBeTruthy()
    expect(sent[0].calendar.events).toHaveLength(1)
    expect(sent[0].calendar.changes).toEqual([])
  })

  it('empty billIds array queues nothing (does NOT fall back to full reprocess)', async () => {
    await seedReproc()
    const { env2, sent } = queueEnv()
    const res = await app.fetch(new Request('http://central/api/tenants/reprocess/ri', { method: 'POST', headers: AUTH, body: JSON.stringify({ billIds: [] }) }), env2)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(0)
  })

  it('drops billIds not linked to the tenant', async () => {
    await seedReproc() // tenant 'ri' has bills 101, 102
    const { env2, sent } = queueEnv()
    const res = await app.fetch(new Request('http://central/api/tenants/reprocess/ri', { method: 'POST', headers: AUTH, body: JSON.stringify({ billIds: [101, 999999] }) }), env2)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].billId).toBe('legiscan:101')
  })

  it('untargeted reprocess queues all bills WITHOUT a calendar block', async () => {
    await seedReproc()
    const { env2, sent } = queueEnv()
    const res = await app.fetch(
      new Request('http://central/api/tenants/reprocess/ri', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({}),
      }),
      env2,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.queued).toBe(2)
    expect(body.targeted).toBe(false)
    expect(body.hasMore).toBe(false)
    expect(body.nextOffset).toBe(2)
    expect(sent).toHaveLength(2)
    expect(sent.every(m => m.calendar === undefined)).toBe(true)
  })
})

describe('POST /tenants/reprocess/:tenantId — dynamic delivery (no static binding)', () => {
  afterEach(() => vi.restoreAllMocks())

  async function seedDynamicTenant() {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values([
      { billId: 201, sessionId: 1, state: 'NJ', stateId: 31, billNumber: 'A1', title: 'NJ bill', changeHash: 'n1', status: 1 },
    ])
    await db.insert(schema.billTenants).values([
      { billId: 201, tenantId: 'nj', matchType: 'manual' },
    ])
    await db.insert(schema.tenants).values({
      tenantId: 'nj', name: 'NJ', stateCoverage: 'NJ', queueId: 'qid-nj-1',
    })
  }

  it('HTTP-publishes to the tenant queueId instead of returning 400', async () => {
    await seedDynamicTenant()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    // No TENANT_QUEUE_NJ binding; REST creds present so deliverBatchToTenant takes the HTTP path.
    const env2: any = { ...TEST_ENV, CF_QUEUES_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' }

    const res = await app.fetch(
      new Request('http://central/api/tenants/reprocess/nj', { method: 'POST', headers: AUTH, body: JSON.stringify({}) }),
      env2,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.queued).toBe(1)
    expect(fetchSpy).toHaveBeenCalled()
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/queues/qid-nj-1/messages/batch')
  })

  it('still 400s when there is neither a binding nor a queueId + REST path', async () => {
    await seedDynamicTenant() // tenant nj has queueId, but env below has no REST creds and no binding
    const env2: any = { ...TEST_ENV } // no CF_QUEUES_TOKEN / CF_ACCOUNT_ID, no TENANT_QUEUE_NJ
    const res = await app.fetch(
      new Request('http://central/api/tenants/reprocess/nj', { method: 'POST', headers: AUTH, body: JSON.stringify({}) }),
      env2,
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /tenants/reprocess/:tenantId — untargeted offset pagination', () => {
  it('offset=0 returns queued=3, hasMore=false, nextOffset=3 for 3-bill tenant', async () => {
    // Seed 3 bills for tenant 'ri'
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values([
      { billId: 201, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'S1', title: 'C', changeHash: 'h3', status: 1 },
      { billId: 202, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'S2', title: 'D', changeHash: 'h4', status: 1 },
      { billId: 203, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'S3', title: 'E', changeHash: 'h5', status: 1 },
    ])
    await db.insert(schema.billTenants).values([
      { billId: 201, tenantId: 'ri', matchType: 'keyword' },
      { billId: 202, tenantId: 'ri', matchType: 'keyword' },
      { billId: 203, tenantId: 'ri', matchType: 'keyword' },
    ])

    const { env2, sent } = queueEnv()
    const res = await app.fetch(
      new Request('http://central/api/tenants/reprocess/ri', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({}),
      }),
      env2,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.queued).toBe(3)
    expect(body.hasMore).toBe(false)
    expect(body.nextOffset).toBe(3)
    expect(sent).toHaveLength(3)
    expect(sent.every(m => m.calendar === undefined)).toBe(true)
  })

  it('offset past the end returns queued=0, hasMore=false', async () => {
    // Seed 3 bills for tenant 'ri'
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values([
      { billId: 301, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'T1', title: 'F', changeHash: 'h6', status: 1 },
      { billId: 302, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'T2', title: 'G', changeHash: 'h7', status: 1 },
      { billId: 303, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'T3', title: 'H', changeHash: 'h8', status: 1 },
    ])
    await db.insert(schema.billTenants).values([
      { billId: 301, tenantId: 'ri', matchType: 'keyword' },
      { billId: 302, tenantId: 'ri', matchType: 'keyword' },
      { billId: 303, tenantId: 'ri', matchType: 'keyword' },
    ])

    const { env2, sent } = queueEnv()
    const res = await app.fetch(
      new Request('http://central/api/tenants/reprocess/ri', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ offset: 3 }),
      }),
      env2,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.queued).toBe(0)
    expect(body.hasMore).toBe(false)
    expect(body.nextOffset).toBe(3)
    expect(sent).toHaveLength(0)
  })

  it('paginates with a small limit: hasMore true then false across pages', async () => {
    // beforeEach resets the DB so only what this test seeds exists
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values([
      { billId: 401, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'U1', title: 'I', changeHash: 'h9', status: 1 },
      { billId: 402, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'U2', title: 'J', changeHash: 'h10', status: 1 },
      { billId: 403, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'U3', title: 'K', changeHash: 'h11', status: 1 },
    ])
    await db.insert(schema.billTenants).values([
      { billId: 401, tenantId: 'ri', matchType: 'keyword' },
      { billId: 402, tenantId: 'ri', matchType: 'keyword' },
      { billId: 403, tenantId: 'ri', matchType: 'keyword' },
    ])

    // page 1: limit 2 → 2 queued, hasMore true, nextOffset 2
    const { env2, sent } = queueEnv()
    const r1 = await app.fetch(
      new Request('http://central/api/tenants/reprocess/ri', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ limit: 2 }),
      }),
      env2,
    )
    expect(r1.status).toBe(200)
    const b1 = await r1.json() as any
    expect(b1.queued).toBe(2)
    expect(b1.hasMore).toBe(true)
    expect(b1.nextOffset).toBe(2)
    expect(sent).toHaveLength(2)

    // page 2: offset 2, limit 2 → 1 queued, hasMore false
    const { env2: env2b, sent: sent2 } = queueEnv()
    const r2 = await app.fetch(
      new Request('http://central/api/tenants/reprocess/ri', {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ offset: 2, limit: 2 }),
      }),
      env2b,
    )
    expect(r2.status).toBe(200)
    const b2 = await r2.json() as any
    expect(b2.queued).toBe(1)
    expect(b2.hasMore).toBe(false)
    expect(sent2).toHaveLength(1)
  })
})

describe('POST /tenants/promote-bills/:tenantId — bulk promote', () => {
  async function seedTwoBills() {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values([
      { billId: 501, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'H501', title: 'A', changeHash: 'h1', status: 1 },
      { billId: 502, sessionId: 1, state: 'RI', stateId: 44, billNumber: 'H502', title: 'B', changeHash: 'h2', status: 1 },
    ])
  }
  function ingestorEnv() {
    const sent: any[] = []
    const env2: any = {
      ...TEST_ENV,
      INGESTOR_QUEUE: {
        send: async (m: any) => sent.push(m),
        sendBatch: async (ms: any[]) => sent.push(...ms.map((x: any) => x.body)),
      },
    }
    return { env2, sent }
  }

  it('upserts match_type=manual and queues forceAI for each bill', async () => {
    await seedTwoBills()
    const { env2, sent } = ingestorEnv()
    const res = await app.fetch(
      new Request('http://central/api/tenants/promote-bills/ri', {
        method: 'POST', headers: AUTH, body: JSON.stringify({ billIds: [501, 502] }),
      }),
      env2,
    )
    expect(res.status).toBe(200)
    expect((await res.json() as any).promoted).toBe(2)

    const db = drizzle(env.DB, { schema })
    const rows = await db.select().from(schema.billTenants).all()
    const ri = rows.filter(r => r.tenantId === 'ri')
    expect(ri.map(r => r.matchType).sort()).toEqual(['manual', 'manual'])
    expect(sent).toHaveLength(2)
    expect(sent.every(m => m.forceAI === true)).toBe(true)
    expect(sent.map(m => m.billId).sort()).toEqual([501, 502])
  })

  it('empty billIds queues nothing', async () => {
    const { env2, sent } = ingestorEnv()
    const res = await app.fetch(
      new Request('http://central/api/tenants/promote-bills/ri', {
        method: 'POST', headers: AUTH, body: JSON.stringify({ billIds: [] }),
      }),
      env2,
    )
    expect(res.status).toBe(200)
    expect((await res.json() as any).promoted).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('rejects over-limit billIds with 400 and queues nothing (H4 quota guard)', async () => {
    // Each promoted bill drives one getBill() in the ingestor against the shared
    // 30k/month LegiScan quota — so the per-request count is capped at 1000.
    const { env2, sent } = ingestorEnv()
    const billIds = Array.from({ length: 1001 }, (_, i) => i + 1)
    const res = await app.fetch(
      new Request('http://central/api/tenants/promote-bills/ri', {
        method: 'POST', headers: AUTH, body: JSON.stringify({ billIds }),
      }),
      env2,
    )
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toMatch(/too many billIds/i)
    expect(sent).toHaveLength(0)
    // Nothing written to bill_tenants either.
    const db = drizzle(env.DB, { schema })
    const rows = await db.select().from(schema.billTenants).all()
    expect(rows.filter(r => r.tenantId === 'ri')).toHaveLength(0)
  })

  it('does NOT reject an under-limit batch (cap fires only above the limit)', async () => {
    // A batch under REPROCESS_LIMIT must pass the cap and queue normally. (Kept
    // small — well under D1's per-statement bound-parameter ceiling. The route
    // upserts all links in a single statement, so it independently breaks for
    // very large batches; chunking that insert is a separate latent bug, out of
    // scope for the quota cap added here.)
    const { env2, sent } = ingestorEnv()
    const billIds = Array.from({ length: 30 }, (_, i) => i + 1)
    const res = await app.fetch(
      new Request('http://central/api/tenants/promote-bills/ri', {
        method: 'POST', headers: AUTH, body: JSON.stringify({ billIds }),
      }),
      env2,
    )
    expect(res.status).toBe(200)
    expect((await res.json() as any).promoted).toBe(30)
    expect(sent).toHaveLength(30)
  })
})

describe('state_coverage maintenance (register merges, seed-session adds state)', () => {
  it('register merges new coverage with existing instead of overwriting', async () => {
    const env2: any = { ...TEST_ENV }
    const reg = (sc: string[]) => app.fetch(new Request('http://central/api/tenants/register', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ tenantId: 'cov', name: 'Cov', apiUrl: 'https://cov.example.com', stateCoverage: sc }),
    }), env2)
    expect((await reg(['NJ', 'RI'])).status).toBe(200)
    expect((await reg(['CA'])).status).toBe(200)
    const db = drizzle(env.DB, { schema })
    const row = await db.select({ sc: schema.tenants.stateCoverage })
      .from(schema.tenants).where(eq(schema.tenants.tenantId, 'cov')).get()
    expect(JSON.parse(row!.sc)).toEqual(['NJ', 'RI', 'CA'])
  })

  it('seed-session adds the session state to the tenant coverage', async () => {
    const env2: any = { ...TEST_ENV }
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values({
      sessionId: 5000, state: 'PA', stateId: 39, yearStart: 2025, yearEnd: 2026,
      sessionTitle: 'T', sessionName: 'T',
    })
    await db.insert(schema.bills).values({
      billId: 700, sessionId: 5000, state: 'PA', stateId: 39,
      billNumber: 'HB1', title: 'X', changeHash: 'h', status: 1,
    })
    // tenant covers only NJ
    await app.fetch(new Request('http://central/api/tenants/register', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ tenantId: 'cov2', name: 'C', apiUrl: 'https://cov2.example.com', stateCoverage: ['NJ'] }),
    }), env2)
    // seed the PA session for cov2 — should add 'PA' to coverage
    const res = await app.fetch(new Request('http://central/api/tenants/seed-session/cov2?sessionId=5000', {
      method: 'POST', headers: AUTH,
    }), env2)
    expect(res.status).toBe(200)
    const row = await db.select({ sc: schema.tenants.stateCoverage })
      .from(schema.tenants).where(eq(schema.tenants.tenantId, 'cov2')).get()
    expect(JSON.parse(row!.sc)).toEqual(['NJ', 'PA'])
  })
})

describe('POST /tenants/redownload-texts/:tenantId', () => {
  // Regression: this endpoint used to re-derive the keyword match from
  // `title + bill_number`, while seed-session classifies on
  // `title + description + bill_number`. A bill that qualified on its
  // description alone was stored as match_type='keyword' but was invisible here,
  // so its text could never be re-downloaded and the endpoint just reported
  // `total: 0`. Indiana hit this on 16 of 40 bills.
  async function seedTextsMissingR2() {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values([
      // Keyword is in the title — found by the old filter too.
      { billId: 201, sessionId: 1, state: 'IN', stateId: 14, billNumber: 'HB1019',
        title: 'Constitutional amendment ballot question.', changeHash: 'h', status: 1 },
      // Keyword is ONLY in the description, like Indiana's "Gaming matters."
      { billId: 202, sessionId: 1, state: 'IN', stateId: 14, billNumber: 'HB1038',
        title: 'Gaming matters.', description: 'Concerns absentee voting procedures.',
        changeHash: 'h', status: 1 },
      // Not a keyword bill at all — must stay out regardless.
      { billId: 203, sessionId: 1, state: 'IN', stateId: 14, billNumber: 'HB9999',
        title: 'Bridge naming.', changeHash: 'h', status: 1 },
      // Keyword bill whose text is already in R2 — nothing to re-download.
      { billId: 204, sessionId: 1, state: 'IN', stateId: 14, billNumber: 'HB1050',
        title: 'Ballot access.', changeHash: 'h', status: 1 },
    ])
    await db.insert(schema.billTenants).values([
      { billId: 201, tenantId: 'ri', matchType: 'keyword' },
      { billId: 202, tenantId: 'ri', matchType: 'keyword' },
      { billId: 203, tenantId: 'ri', matchType: null },
      { billId: 204, tenantId: 'ri', matchType: 'keyword' },
    ])
    await db.insert(schema.billTexts).values([
      { docId: 9001, billId: 201, date: '2026-01-01', type: 'Introduced', mime: 'application/pdf', stateLink: 'https://x/1.pdf' },
      { docId: 9002, billId: 202, date: '2026-01-01', type: 'Introduced', mime: 'application/pdf', stateLink: 'https://x/2.pdf' },
      { docId: 9003, billId: 203, date: '2026-01-01', type: 'Introduced', mime: 'application/pdf', stateLink: 'https://x/3.pdf' },
      { docId: 9004, billId: 204, date: '2026-01-01', type: 'Introduced', mime: 'application/pdf', stateLink: 'https://x/4.pdf', r2Key: 'bills/legiscan-204/texts/9004.pdf' },
    ])
    // Present specifically to prove the endpoint no longer consults them: bill
    // 202's title matches none of these.
    await db.insert(schema.keywordRegistry).values([
      { tenantId: 'ri', keyword: 'ballot' },
      { tenantId: 'ri', keyword: 'absentee' },
    ])
  }

  function ingestorEnv() {
    const sent: any[] = []
    const env2: any = {
      ...TEST_ENV,
      INGESTOR_QUEUE: {
        send: async (m: any) => sent.push(m),
        sendBatch: async (ms: any[]) => sent.push(...ms.map((x: any) => x.body)),
      },
    }
    return { env2, sent }
  }

  it('queues every keyword bill missing an r2_key, including description-only matches', async () => {
    await seedTextsMissingR2()
    const { env2, sent } = ingestorEnv()

    const res = await app.fetch(
      new Request('http://central/api/tenants/redownload-texts/ri', { method: 'POST', headers: AUTH }),
      env2,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, queued: 2, total: 2 })

    const ids = sent.map((m: any) => m.billId).sort()
    // 202 is the one the old title-only re-match dropped.
    expect(ids).toEqual([201, 202])
    // 203 is not a keyword bill; 204 already has its text.
    expect(ids).not.toContain(203)
    expect(ids).not.toContain(204)
    // Zero LegiScan API calls: the ingestor must not re-fetch the bill.
    expect(sent.every((m: any) => m.skipFetch === true)).toBe(true)
  })
})
