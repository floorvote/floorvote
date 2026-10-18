import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { getProvider } from '../../src/providers'
import { createAdminSession } from '../../src/lib/adminAuth'
import { signSuperadminJwt } from '../../src/lib/superadminJwt'

async function genKeys(): Promise<{ priv: string; pub: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    priv: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).privateKey)),
    pub: JSON.stringify(await crypto.subtle.exportKey('jwk', (kp as CryptoKeyPair).publicKey)),
  }
}
const keys = await genKeys()

const TEST_ENV: any = {
  ...env, ADMIN_SECRET: 'sek', LIMS_API_KEY: 'test-api-key',
  SUPERADMIN_JWT_PUBLIC_KEY: keys.pub, SUPERADMIN_EMAILS: 'admin@example.com',
}
const AUTH = { Authorization: 'Bearer sek' }
const URL = 'http://central/admin/dash/states'
const LIMS_STATE = getProvider('lims').states![0]
const MGA_STATE = getProvider('mga').states![0]
const LIS_STATE = getProvider('lis').states![0]
const db = () => drizzle(env.DB, { schema })
const get = (init: RequestInit = { headers: AUTH }, e: any = TEST_ENV) => app.fetch(new Request(URL, init), e)

beforeEach(async () => { await setupLsDb() })

describe('GET /admin/dash/states: auth', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await get({})).status).toBe(401)
  })

  it('refuses a wrong bearer secret', async () => {
    expect((await get({ headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
  })

  it('refuses an unknown or expired admin session cookie', async () => {
    expect((await get({ headers: { Cookie: 'admin_session=not-a-real-token' } })).status).toBe(401)
    const { rawToken } = await createAdminSession(db(), 'admin@example.com', { ttlMs: -1000 })
    expect((await get({ headers: { Cookie: `admin_session=${rawToken}` } })).status).toBe(401)
  })

  it('refuses a signed-in user who is not a superadmin', async () => {
    const jwt = await signSuperadminJwt('outsider@example.com', 'Out', keys.priv)
    expect((await get({ headers: { Cookie: `superadmin_jwt=${jwt}` } })).status).toBe(403)
  })

  it('answers a superadmin, by session cookie and by bearer secret', async () => {
    const { rawToken } = await createAdminSession(db(), 'admin@example.com')
    expect((await get({ headers: { Cookie: `admin_session=${rawToken}` } })).status).toBe(200)
    expect((await get()).status).toBe(200)
  })

  it('answers no data to a refused request', async () => {
    await db().insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims' })
    const res = await get({})
    expect(JSON.stringify(await res.json())).not.toContain(LIMS_STATE)
  })
})

describe('GET /admin/dash/states: rows', () => {
  it('answers an empty list when central holds nothing', async () => {
    const body = await (await get()).json() as any
    expect(body.data.states).toEqual([])
    expect(body.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('shows a LegiScan-only central with nothing marked as a problem', async () => {
    await db().insert(schema.tenants).values({ tenantId: 'a', name: 'Team A', stateCoverage: '["RI","NJ"]', active: true } as any)
    const body = await (await get()).json() as any
    expect(body.data.states.map((r: any) => r.state)).toEqual(['NJ', 'RI'])
    for (const r of body.data.states) {
      expect(r.provider).toMatchObject({ id: 'legiscan', sinceKind: 'default', undoAvailable: false })
      expect(r.configured.warning).toBeNull()
    }
  })

  it('assembles every column of a cut-over state', async () => {
    const d = db()
    await d.insert(schema.tenants).values({ tenantId: 'a', name: 'Team A', stateCoverage: `["${LIMS_STATE}"]`, active: true } as any)
    await d.insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims', previousProvider: 'legiscan', claimedAt: '2026-09-20 08:00:00' })
    await d.insert(schema.cutovers).values({ id: 'c1', state: LIMS_STATE, fromProvider: 'legiscan', toProvider: 'lims', createdAt: '2026-09-20 08:00:00' })
    await d.insert(schema.sessions).values({
      sessionId: 1, state: LIMS_STATE, stateId: 1, yearStart: 2026, yearEnd: 2026, sessionTitle: 't', sessionName: 'n', provider: 'lims',
      lastSyncedAt: '2026-10-14 05:00:00', fullSyncHoursEt: '[6]',
    } as any)
    await d.insert(schema.bills).values({ billId: 1, sessionId: 1, state: LIMS_STATE, stateId: 1, billNumber: 'B1', changeHash: 'h', title: 't', carriedFrom: 'legiscan' } as any)
    await d.insert(schema.apiCallLog).values({ callType: 'lims:Members', params: '{}', loggedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') })
    const body = await (await get()).json() as any
    const r = body.data.states.find((s: any) => s.state === LIMS_STATE)
    expect(r.provider).toMatchObject({ id: 'lims', sinceKind: 'cutover', since: '2026-09-20T08:00:00.000Z', undoAvailable: true })
    expect(r.configured).toMatchObject({ keyStatus: 'set', queue: 'shared', warning: null })
    expect(r.schedule).toMatchObject({ fullHours: [6], override: true, lastRead: '2026-10-14T05:00:00.000Z' })
    expect(r.waitingFirstIngest).toBe(1)
    expect(r.calls).toEqual({ provider: 'lims', count: 1, coverage: 'full' })
    expect(r.capabilities.bodyEvents).toBe(true)
  })

  it('warns about an unconfigured owner and marks Maryland not recorded and Virginia partial', async () => {
    const d = db()
    await d.insert(schema.stateProviders).values([
      { state: LIMS_STATE, provider: 'lims' }, { state: MGA_STATE, provider: 'mga' }, { state: LIS_STATE, provider: 'lis' },
    ])
    const body = await (await get({ headers: AUTH }, { ...TEST_ENV, LIMS_API_KEY: undefined, MGA_INGESTOR_QUEUE: {} })).json() as any
    const by = (s: string) => body.data.states.find((r: any) => r.state === s)
    expect(by(LIMS_STATE).configured.warning).toMatch(/isn't configured/)
    expect(by(MGA_STATE).configured).toMatchObject({ warning: null, queue: 'own' })
    expect(by(MGA_STATE).calls.coverage).toBe('none')
    expect(by(LIS_STATE).calls.coverage).toBe('partial')
    expect(by(LIS_STATE).configured.queue).toBe('shared')
  })

  it('carries no secret value', async () => {
    await db().insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims' })
    const text = await (await get()).text()
    for (const secret of ['test-api-key', 'sek', keys.pub]) expect(text).not.toContain(secret)
  })

  it('lists a state served by two providers once, under its owner', async () => {
    const d = db()
    await d.insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims' })
    await d.insert(schema.sessions).values([
      { sessionId: 1, state: LIMS_STATE, stateId: 1, yearStart: 2025, yearEnd: 2025, sessionTitle: 't', sessionName: 'old', provider: 'legiscan' },
      { sessionId: 2, state: LIMS_STATE, stateId: 1, yearStart: 2026, yearEnd: 2026, sessionTitle: 't', sessionName: 'new', provider: 'lims' },
    ] as any)
    const rows = ((await (await get()).json()) as any).data.states.filter((r: any) => r.state === LIMS_STATE)
    expect(rows).toHaveLength(1)
    expect(rows[0].provider).toMatchObject({ id: 'lims', otherProviders: ['legiscan'] })
  })

  it('shows a state with no tenants and a provider with no recent sync as stale', async () => {
    await db().insert(schema.stateProviders).values({ state: LIMS_STATE, provider: 'lims' })
    const r = ((await (await get()).json()) as any).data.states[0]
    expect(r).toMatchObject({ state: LIMS_STATE, tenantCount: 0 })
    expect(r.schedule).toMatchObject({ lastRead: null, nextRead: null, stale: true })
  })
})
