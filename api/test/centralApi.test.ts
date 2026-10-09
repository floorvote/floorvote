import { describe, it, expect, beforeEach } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'
import { CentralApi } from '../src/centralApi'
import { resetDb, applyMigrations } from './helpers'
import { getDb } from '../src/db/client'
import { bills } from '../src/db/schema'

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

describe('CentralApi RPC entrypoint', () => {
  it('engagementStats() returns a snapshot with metrics', async () => {
    const entry = new CentralApi(createExecutionContext(), env)
    const snap = await entry.engagementStats()
    expect(snap.metrics).toHaveProperty('total_members')
    expect(typeof snap.computedAt).toBe('string')
  })

  it('forceRegister() resolves to a boolean', async () => {
    const entry = new CentralApi(createExecutionContext(), env)
    const ok = await entry.forceRegister()
    expect(typeof ok).toBe('boolean')
  })

  it('rekeyBills() moves bills to new central ids, keeping each row', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values([
      { id: 'b1', externalId: 'legiscan:100', billNumber: 'HB1', title: 'One', state: 'MD', priority: 'high' },
      { id: 'b2', externalId: 'legiscan:200', billNumber: 'HB2', title: 'Two', state: 'MD' },
      { id: 'b3', externalId: 'legiscan:3000000003', billNumber: 'HB3', title: 'Three', state: 'MD' },
      { id: 'b4', externalId: 'legiscan:300', billNumber: 'HB3', title: 'Three (old)', state: 'MD' },
    ])
    const entry = new CentralApi(createExecutionContext(), env)
    const r = await entry.rekeyBills([
      { from: 'legiscan:100', to: 'legiscan:3000000001' },
      { from: 'legiscan:200', to: 'legiscan:3000000002' },
      { from: 'legiscan:300', to: 'legiscan:3000000003' },
      { from: 'legiscan:999', to: 'legiscan:3000000009' },
    ])
    expect(r).toEqual({ rekeyed: 2, missing: ['legiscan:999'], conflicts: ['legiscan:300'] })
    const rows = Object.fromEntries((await db.select().from(bills).all()).map(b => [b.id, b]))
    expect(rows.b1).toMatchObject({ externalId: 'legiscan:3000000001', priority: 'high' })
    expect(rows.b2.externalId).toBe('legiscan:3000000002')
    expect(rows.b4.externalId).toBe('legiscan:300')
  })

  it('sendSampleEmail() rejects an invalid type without sending', async () => {
    const entry = new CentralApi(createExecutionContext(), env)
    const r = await entry.sendSampleEmail('a@b.com', 'not-a-real-type')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid type')
  })
})
