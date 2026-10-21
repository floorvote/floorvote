import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import { clearDb } from '../helpers/migrations'

// The operator routes scripts/verify-instance.sh drives. None may call LegiScan,
// change which bills a tenant tracks, or feed the ingestor.

const AUTH = { 'x-admin-secret': 'sek', 'content-type': 'application/json' }
const BASE: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => { await clearDb() })
afterEach(() => { vi.unstubAllGlobals() })

async function seedTenant(over: Partial<typeof schema.tenants.$inferInsert> = {}) {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({
    tenantId: 'ri', name: 'Rhode Island Clerks', apiUrl: 'https://ri.example.org',
    stateCoverage: '["RI"]', active: true, ...over,
  })
  return db
}

async function seedBills(db: ReturnType<typeof drizzle<typeof schema>>) {
  const bill = (billId: number, state: string, billNumber: string) =>
    ({ billId, sessionId: 1, state, stateId: 1, billNumber, title: `Bill ${billNumber}`, changeHash: `h${billId}`, status: 1 })
  await db.insert(schema.bills).values([
    bill(100, 'RI', 'H100'), bill(101, 'RI', 'H101'), bill(200, 'NJ', 'A200'),
  ])
  // Only H100 has downloaded text.
  await db.insert(schema.billTexts).values({ docId: 9000, billId: 100, date: '2026-01-01', type: 'Introduced', r2Key: 'texts/100.html' })
}

// By default the instance is bound and understands the delivery probe; pass null
// for one central has no binding for, or an object for a different RPC surface.
function queueEnv(rpc: object | null = { deliveryProbe: async () => ({ probe: null }) }) {
  const sent: any[] = []
  const ingestor: any[] = []
  const env2: any = {
    ...BASE,
    ...(rpc ? { TENANT_RI: rpc } : {}),
    INGESTOR_QUEUE: { send: async (m: any) => ingestor.push(m), sendBatch: async (ms: any[]) => ingestor.push(...ms) },
    TENANT_QUEUE_RI: { send: async (m: any) => sent.push(m), sendBatch: async (ms: any[]) => sent.push(...ms.map((x: any) => x.body)) },
  }
  return { env2, sent, ingestor }
}

const call = (path: string, init: RequestInit, e: any) =>
  app.fetch(new Request(`http://central/api/tenants/${path}`, init), e)

// A guard on the router, not on any one route: these are operator routes and
// must stay behind the admin secret. (Green before the routes exist, by design.)
describe('verification routes require the admin secret', () => {
  it.each([
    ['GET', 'ri/registration'], ['POST', 'ri/verify-delivery'], ['GET', 'ri/delivery-probe'], ['POST', 'ri/verify-ai'],
  ])('%s %s', async (method, path) => {
    const db = await seedTenant()
    await seedBills(db)
    const e: any = { ...queueEnv().env2, TENANT_RI: { deliveryProbe: async () => ({ probe: null }), verifyAi: async () => ({ status: 'ok' }) } }
    const res = await call(path, { method, ...(method === 'POST' ? { body: JSON.stringify({ nonce: 'n' }) } : {}) }, e)
    expect(res.status).toBe(401)
  })
})

describe('GET /tenants/:id/registration', () => {
  it('404s for an instance central has never registered', async () => {
    const res = await call('ri/registration', { headers: AUTH }, BASE)
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error).toMatch(/not registered/)
  })

  it('reports the registration, its states and keywords, and how bills would reach it', async () => {
    const db = await seedTenant({ stateCoverage: '["NJ","RI"]' })
    await db.insert(schema.keywordRegistry).values([{ tenantId: 'ri', keyword: 'ballot' }, { tenantId: 'ri', keyword: 'poll worker' }])
    const e = { ...queueEnv().env2, TENANT_RI: { forceRegister: async () => true } }
    const res = await call('ri/registration', { headers: AUTH }, e)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      tenantId: 'ri', active: true, apiUrl: 'https://ri.example.org',
      stateCoverage: ['NJ', 'RI'], keywordCount: 2, bound: true, deliveryPath: 'binding',
    })
  })

  it('says so when central has no CentralApi binding for the instance', async () => {
    await seedTenant()
    const res = await call('ri/registration', { headers: AUTH }, queueEnv(null).env2)
    expect((await res.json() as any).bound).toBe(false)
  })

  it('says so when there is no queue binding and no queue id', async () => {
    await seedTenant()
    const res = await call('ri/registration', { headers: AUTH }, BASE)
    expect((await res.json() as any).deliveryPath).toBe('none')
  })
})

describe('POST /tenants/:id/verify-delivery', () => {
  it('sends one probe naming a stored bill down the instance queue, and nothing else', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const { env2, sent, ingestor } = queueEnv()
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)

    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n-123' }) }, env2)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, nonce: 'n-123', billId: 'legiscan:100', via: 'binding' })
    // The message the instance's consumer will see: a probe, not a bill to track.
    expect(sent).toEqual([{ tenantId: 'ri', billId: 'legiscan:100', probe: 'n-123' }])
    expect(ingestor).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    // No change to which bills the instance tracks.
    expect(await db.select().from(schema.billTenants).all()).toEqual([])
  })

  it('prefers a bill in the instance own states that has stored text', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const { env2 } = queueEnv()
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n' }) }, env2)
    expect((await res.json() as any).billId).toBe('legiscan:100')
  })

  it('falls back to a bill in its states without text, then to any stored bill', async () => {
    const db = await seedTenant()
    await db.insert(schema.bills).values({ billId: 7, sessionId: 1, state: 'RI', stateId: 1, billNumber: 'H7', title: 't', changeHash: 'h', status: 1 })
    const first = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'a' }) }, queueEnv().env2)
    expect((await first.json() as any).billId).toBe('legiscan:7')

    await db.delete(schema.bills)
    await db.insert(schema.bills).values({ billId: 9, sessionId: 1, state: 'NJ', stateId: 1, billNumber: 'A9', title: 't', changeHash: 'h', status: 1 })
    const second = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'b' }) }, queueEnv().env2)
    expect((await second.json() as any).billId).toBe('legiscan:9')
  })

  it('404s when central stores no bill at all', async () => {
    await seedTenant()
    const { env2, sent } = queueEnv()
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n' }) }, env2)
    expect(res.status).toBe(404)
    expect(((await res.json()) as any).error).toMatch(/no stored bill/)
    expect(sent).toEqual([])
  })

  it('409s when central has no way to deliver to the instance', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const e: any = { ...BASE, TENANT_RI: { deliveryProbe: async () => ({ probe: null }) } }
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n' }) }, e)
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).predates).toBeUndefined()
  })

  // An instance from before the probe existed would treat it as an ordinary bill
  // notification: track the bill, spend a model call, and post a feed event its
  // members can see. Central must not send one to it.
  it('refuses, and queues nothing, when the instance predates the probe', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const old = { deliveryProbe: async () => { throw new Error('The RPC receiver does not implement the method "deliveryProbe"') } }
    const { env2, sent, ingestor } = queueEnv(old)
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n' }) }, env2)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ predates: true })
    expect(sent).toEqual([])
    expect(ingestor).toEqual([])
  })

  it('501s, and queues nothing, when central is not bound to the instance', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const { env2, sent } = queueEnv(null)
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n' }) }, env2)
    expect(res.status).toBe(501)
    expect(sent).toEqual([])
  })

  it('picks the newest text-bearing bill across all the instance states, not the newest text', async () => {
    const db = await seedTenant({ stateCoverage: '["NJ","RI"]' })
    await seedBills(db)
    // NJ's bill is newer but its text was stored earlier than RI's.
    await db.insert(schema.billTexts).values({ docId: 8000, billId: 200, date: '2026-01-01', type: 'Introduced', r2Key: 'texts/200.html' })
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n' }) }, queueEnv().env2)
    expect((await res.json() as any).billId).toBe('legiscan:200')
  })

  it('400s without a nonce, and 404s for an unregistered instance', async () => {
    const db = await seedTenant()
    await seedBills(db)
    expect((await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: '{}' }, queueEnv().env2)).status).toBe(400)
    expect((await call('zz/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n' }) }, queueEnv().env2)).status).toBe(404)
  })
})

describe('GET /tenants/:id/delivery-probe', () => {
  it('returns what the instance recorded', async () => {
    const probe = { nonce: 'n', billId: 'legiscan:100', receivedAt: '2026-10-14 12:00:00', readStatus: 200 }
    const e: any = { ...BASE, TENANT_RI: { deliveryProbe: async () => ({ probe }) } }
    const res = await call('ri/delivery-probe', { headers: AUTH }, e)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ probe })
  })

  it('501s when the instance is not bound, and 502s with the message when the call throws', async () => {
    expect((await call('ri/delivery-probe', { headers: AUTH }, BASE)).status).toBe(501)
    const e: any = { ...BASE, TENANT_RI: { deliveryProbe: async () => { throw new Error('boom') } } }
    const res = await call('ri/delivery-probe', { headers: AUTH }, e)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})

describe('POST /tenants/:id/verify-ai', () => {
  it('asks the instance to analyze one stored bill and returns its answer', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const seen: string[] = []
    const e: any = { ...BASE, TENANT_RI: { verifyAi: async (billId: string) => { seen.push(billId); return { status: 'ok', billNumber: 'H100' } } } }
    const res = await call('ri/verify-ai', { method: 'POST', headers: AUTH }, e)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', billNumber: 'H100' })
    expect(seen).toEqual(['legiscan:100'])
    expect(await db.select().from(schema.billTenants).all()).toEqual([])
  })

  it('passes a skipped answer through', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const e: any = { ...BASE, TENANT_RI: { verifyAi: async () => ({ status: 'skipped', reason: 'CF_AIG_GATEWAY is not set' }) } }
    const res = await call('ri/verify-ai', { method: 'POST', headers: AUTH }, e)
    expect(await res.json()).toEqual({ status: 'skipped', reason: 'CF_AIG_GATEWAY is not set' })
  })

  it('502s with the instance error message when the analysis throws', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const e: any = { ...BASE, TENANT_RI: { verifyAi: async () => { throw new Error('402 Insufficient wholesale credits') } } }
    const res = await call('ri/verify-ai', { method: 'POST', headers: AUTH }, e)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: '402 Insufficient wholesale credits' })
  })

  it('501s when the instance is not bound, and 404s when central stores no bill', async () => {
    const db = await seedTenant()
    await seedBills(db)
    expect((await call('ri/verify-ai', { method: 'POST', headers: AUTH }, BASE)).status).toBe(501)
    await db.delete(schema.billTexts)
    await db.delete(schema.bills)
    const e: any = { ...BASE, TENANT_RI: { verifyAi: async () => ({ status: 'ok' }) } }
    expect((await call('ri/verify-ai', { method: 'POST', headers: AUTH }, e)).status).toBe(404)
  })
})

// Release 2 of the neutral handle rename (#305): the probe and the AI check name
// the bill in the form the instance reads, as every other message does. An
// instance whose CentralApi binding reports neutral handles gets `bill:<n>`, and
// any other gets `legiscan:<n>`, and the route reports the handle it sent.
describe('verification handles follow what the instance reads', () => {
  const capable = { deliveryProbe: async () => ({ probe: null }), capabilities: async () => ({ neutralHandles: true }) }

  it('probes a release-1 instance with the legacy handle, and reports that handle', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const { env2, sent } = queueEnv({ deliveryProbe: async () => ({ probe: null }) })
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n-1' }) }, env2)
    expect(await res.json()).toMatchObject({ billId: 'legiscan:100' })
    expect(sent).toEqual([{ tenantId: 'ri', billId: 'legiscan:100', probe: 'n-1' }])
  })

  it('probes an instance that reports neutral handles with the neutral handle, and reports that handle', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const { env2, sent } = queueEnv(capable)
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n-2' }) }, env2)
    expect(await res.json()).toMatchObject({ ok: true, billId: 'bill:100', via: 'binding' })
    expect(sent).toEqual([{ tenantId: 'ri', billId: 'bill:100', probe: 'n-2' }])
  })

  it('probes with the legacy handle when the capability call fails', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const { env2, sent } = queueEnv({ deliveryProbe: async () => ({ probe: null }), capabilities: async () => { throw new Error('boom') } })
    const res = await call('ri/verify-delivery', { method: 'POST', headers: AUTH, body: JSON.stringify({ nonce: 'n-3' }) }, env2)
    expect(await res.json()).toMatchObject({ billId: 'legiscan:100' })
    expect(sent).toEqual([{ tenantId: 'ri', billId: 'legiscan:100', probe: 'n-3' }])
  })

  it('asks a release-1 instance to analyze the bill by its legacy handle', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const seen: string[] = []
    const e: any = { ...BASE, TENANT_RI: { verifyAi: async (billId: string) => { seen.push(billId); return { status: 'ok' } } } }
    await call('ri/verify-ai', { method: 'POST', headers: AUTH }, e)
    expect(seen).toEqual(['legiscan:100'])
  })

  it('asks an instance that reports neutral handles to analyze the bill by its neutral handle', async () => {
    const db = await seedTenant()
    await seedBills(db)
    const seen: string[] = []
    const e: any = { ...BASE, TENANT_RI: { ...capable, verifyAi: async (billId: string) => { seen.push(billId); return { status: 'ok' } } } }
    await call('ri/verify-ai', { method: 'POST', headers: AUTH }, e)
    expect(seen).toEqual(['bill:100'])
  })
})
