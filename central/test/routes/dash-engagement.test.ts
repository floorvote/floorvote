import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

// Freeze the clock so the hardcoded seed statDates (2026-05-27/28) always fall
// inside the relative `?days=N` windows the endpoints compute from "now".
// Only Date is faked (not setTimeout/Promise) so async DB calls are unaffected.
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-05-29T12:00:00Z'))
  await setupLsDb()
})

afterEach(() => {
  vi.useRealTimers()
})

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }

async function seedSomeStats() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values([
    { tenantId: 'ri', name: 'Rhode Island', apiUrl: 'https://ri.example/api', stateCoverage: '["RI"]', active: true } as any,
    { tenantId: 'acme', name: 'Acme', apiUrl: 'https://acme.example/api', stateCoverage: '["RI"]', active: true } as any,
  ])
  await db.insert(schema.tenantStats).values([
    { tenantId: 'ri', statDate: '2026-05-27', totalMembers: 10, votesCast: 30 } as any,
    { tenantId: 'ri', statDate: '2026-05-28', totalMembers: 11, votesCast: 33 } as any,
    { tenantId: 'acme', statDate: '2026-05-28', totalMembers: 5, votesCast: 12 } as any,
  ])
}

describe('dash-engagement route group', () => {
  it('returns 401 on unknown sub-path without auth', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/engagement/__nope'), env as any)
    expect(res.status).toBe(401)
  })
})

describe('GET /admin/dash/engagement/overview', () => {
  it('returns aggregate sums across latest-per-tenant rows', async () => {
    await seedSomeStats()
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/overview', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenantCount).toBe(2)
    // RI latest = 05-28 (11 members, 33 votes); Acme latest = 05-28 (5 members, 12 votes)
    expect(body.data.totals.total_members).toBe(16)
    expect(body.data.totals.votes_cast).toBe(45)
  })

  it('returns zeros when no stats exist', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/overview', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenantCount).toBe(0)
    expect(body.data.totals.total_members).toBe(0)
  })
})

describe('GET /admin/dash/engagement/series', () => {
  it('returns columnar series with one entry per (metric, tenant)', async () => {
    await seedSomeStats()
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/series?days=7', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenants).toEqual([
      { id: 'acme', name: 'Acme' },
      { id: 'ri', name: 'Rhode Island' },
    ])
    expect(body.data.dates).toContain('2026-05-28')
    expect(body.data.metrics.total_members.ri).toEqual(expect.arrayContaining([10, 11]))
    expect(body.data.metrics.votes_cast.acme).toEqual(expect.arrayContaining([12]))
    // missing day for acme on 05-27 → null
    const idx27 = body.data.dates.indexOf('2026-05-27')
    expect(body.data.metrics.total_members.acme[idx27]).toBeNull()
  })
})

describe('GET /admin/dash/engagement/tenants/:id', () => {
  it('returns one tenant\'s series', async () => {
    await seedSomeStats()
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/tenants/ri?days=7', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenant).toEqual({ id: 'ri', name: 'Rhode Island' })
    expect(body.data.metrics.total_members).toEqual(expect.arrayContaining([10, 11]))
  })

  it('returns 404 for unknown tenant', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/tenants/nope', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /admin/dash/engagement/export', () => {
  it('returns CSV with header and one row per (tenant, date)', async () => {
    await seedSomeStats()
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/export?format=csv&days=7', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/csv/)
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="engagement-stats-\d{4}-\d{2}-\d{2}\.csv"/)
    const text = await res.text()
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('tenant_id,tenant_name,stat_date,total_members,active_members_7d,active_members_30d,votes_cast,comments_written,comment_reactions,positions_set,notes_created,custom_field_values,bills_with_engagement,roles_defined,custom_fields_defined,bills_ai_processed')
    expect(lines.length).toBe(4) // 3 seeded rows + header
    // acme row sorts before ri (alphabetical)
    expect(lines[1]).toMatch(/^acme,/)
  })

  it('returns JSON when format=json', async () => {
    await seedSomeStats()
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/export?format=json&days=7', { headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/)
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename="engagement-stats-\d{4}-\d{2}-\d{2}\.json"/)
    const body = await res.json() as any
    expect(body.data.tenants.length).toBe(2)
  })

  it('quotes tenant_name containing a comma', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'xx', name: 'Foo, Inc.', apiUrl: 'https://x.example/api', stateCoverage: '["RI"]', active: true } as any,
    ])
    await db.insert(schema.tenantStats).values([
      { tenantId: 'xx', statDate: '2026-05-28', totalMembers: 1 } as any,
    ])
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/export?format=csv&days=7', { headers: AUTH }),
      TEST_ENV,
    )
    const text = await res.text()
    expect(text).toContain('"Foo, Inc."')
  })
})

describe('POST /admin/dash/engagement/refresh/:id', () => {
  it('triggers a single-tenant pull and returns the upserted row', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'Rhode Island', apiUrl: 'https://ri.example/api', stateCoverage: '["RI"]', active: true } as any,
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { computedAt: '2026-05-29T06:00:00Z', metrics: { total_members: 42, votes_cast: 100 } },
      meta: { generatedAt: '2026-05-29T06:00:00Z' },
    }), { status: 200 }))
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/refresh/ri', { method: 'POST', headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.tenantId).toBe('ri')
    expect(body.data.metrics.total_members).toBe(42)
  })

  it('returns 502 when tenant fetch fails', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'Rhode Island', apiUrl: 'https://ri.example/api', stateCoverage: '["RI"]', active: true } as any,
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/refresh/ri', { method: 'POST', headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(502)
  })

  it('returns 404 for unknown tenant', async () => {
    const res = await app.fetch(
      new Request('http://central/admin/dash/engagement/refresh/nope', { method: 'POST', headers: AUTH }),
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})
