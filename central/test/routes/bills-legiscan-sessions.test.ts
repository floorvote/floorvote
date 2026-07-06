import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

beforeEach(async () => {
  await setupLsDb()
})

async function seedSessions() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values([
    {
      sessionId: 1,
      state: 'RI',
      stateId: 39,
      yearStart: 2025,
      yearEnd: 2026,
      sessionName: 'Rhode Island 2025-2026 Regular Session',
      sessionTitle: 'Regular Session',
    },
    {
      sessionId: 2,
      state: 'RI',
      stateId: 39,
      yearStart: 2023,
      yearEnd: 2024,
      sessionName: 'Rhode Island 2023-2024 Regular Session',
      sessionTitle: 'Regular Session',
    },
    {
      sessionId: 3,
      state: 'MA',
      stateId: 21,
      yearStart: 2025,
      yearEnd: 2026,
      sessionName: 'Massachusetts 2025-2026 Regular Session',
      sessionTitle: 'Regular Session',
    },
  ])
}

async function seedBillForState(billId: number, sessionId: number, state: string) {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.bills).values({
    billId,
    sessionId,
    state,
    stateId: 1,
    billNumber: `H${billId}`,
    title: `Bill ${billId}`,
    changeHash: 'abc123',
    status: 1,
  })
}

describe('GET /bills/sessions', () => {
  it('returns 401 without admin secret', async () => {
    const res = await app.request('/api/bills/sessions?state=RI', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns 400 when state param is missing', async () => {
    const res = await app.request('/api/bills/sessions', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('state is required')
  })

  it('returns sessions for a valid state', async () => {
    await seedSessions()
    const res = await app.request('/api/bills/sessions?state=RI', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: unknown[] }
    expect(body.sessions).toHaveLength(2)
    const session = (body.sessions as Array<Record<string, unknown>>).find(s => s.sessionId === 1)
    expect(session).toMatchObject({
      sessionId: 1,
      sessionName: 'Rhode Island 2025-2026 Regular Session',
      state: 'RI',
      yearStart: 2025,
      yearEnd: 2026,
    })
  })

  it('normalizes state param to uppercase', async () => {
    await seedSessions()
    const res = await app.request('/api/bills/sessions?state=ri', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: unknown[] }
    expect(body.sessions).toHaveLength(2)
  })

  it('returns empty array (not 404) for a state with no sessions', async () => {
    await seedSessions()
    const res = await app.request('/api/bills/sessions?state=TX', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })

  it('returns empty array when the sessions table is empty', async () => {
    const res = await app.request('/api/bills/sessions?state=RI', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })
})

describe('GET /bills/:id — unaffected by sessions route', () => {
  it('returns 400 for a non-numeric id (shadows check)', async () => {
    const res = await app.request('/api/bills/sessions-not-a-number', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    // "sessions-not-a-number" is not a valid integer bill id
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid bill id')
  })

  it('returns bill data for a real integer bill id', async () => {
    await seedSessions()
    await seedBillForState(42, 1, 'RI')
    const res = await app.request('/api/bills/42', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { billId: string; state: string }
    expect(body.billId).toBe('legiscan:42')
    expect(body.state).toBe('RI')
  })

  it('returns bill data for a legiscan-prefixed bill id', async () => {
    await seedSessions()
    await seedBillForState(99, 1, 'RI')
    const res = await app.request('/api/bills/legiscan:99', {
      headers: { 'x-admin-secret': 'test-secret' },
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { billId: string }
    expect(body.billId).toBe('legiscan:99')
  })
})
