import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import app from '../../src/index'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import * as schema from '../../src/db/schema'

const TEST_ENV: any = { ...env, CENTRAL_ADMIN_SECRET: 'sek' }

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
})

describe('GET /api/internal/engagement-stats', () => {
  it('returns 401 without secret', async () => {
    const res = await app.fetch(new Request('http://t/api/internal/engagement-stats'), TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong secret', async () => {
    const res = await app.fetch(
      new Request('http://t/api/internal/engagement-stats', { headers: { 'x-admin-secret': 'wrong' } }),
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns the 13 metrics with correct secret', async () => {
    const db = getDb(env.DB)
    await db.insert(schema.users).values([{ id: 'u1', email: 'a@x.com', name: 'A', role: 'admin' }])
    const res = await app.fetch(
      new Request('http://t/api/internal/engagement-stats', { headers: { 'x-admin-secret': 'sek' } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.metrics.total_members).toBe(1)
    expect(body.data.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof body.data.metrics.bills_ai_processed).toBe('number')
    expect(body.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('GET /api/internal/engagement-stats — resend block', () => {
  it('includes a resend block sourced from association_config', async () => {
    const db = getDb(env.DB)
    await db.insert(schema.associationConfig).values([
      { key: 'resend_monthly_used', value: '321' },
      { key: 'resend_daily_used', value: '7' },
      { key: 'resend_used_at', value: '2026-06-05T06:00:00Z' },
      { key: 'resend_last_429_at', value: '' },
    ])
    const res = await app.fetch(
      new Request('http://t/api/internal/engagement-stats', { headers: { 'x-admin-secret': 'sek' } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.resend.monthlyUsed).toBe(321)
    expect(body.data.resend.dailyUsed).toBe(7)
    expect(body.data.resend.usedAt).toBe('2026-06-05T06:00:00Z')
    expect(body.data.resend.last429At).toBe('')
  })

  it('reports zeros/empty when no resend config present', async () => {
    const res = await app.fetch(
      new Request('http://t/api/internal/engagement-stats', { headers: { 'x-admin-secret': 'sek' } }),
      TEST_ENV,
    )
    const body = await res.json() as any
    expect(body.data.resend.monthlyUsed).toBe(0)
    expect(body.data.resend.usedAt).toBe('')
  })
})
