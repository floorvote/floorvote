import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import migration0001 from '../../migrations/0001_initial.sql?raw'
import migration0003 from '../../migrations/0003_openstates_migration.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map((s) =>
      s.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim(),
    )
    .filter((s) => s.length > 0)
    .map((s) => s + ';')
  return { name, queries }
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0003, '0003_openstates_migration'),
  ])
})

describe('POST /tenants/register', () => {
  it('creates tenant and keyword registry entries', async () => {
    const res = await app.request('/tenants/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': 'test-secret' },
      body: JSON.stringify({
        tenantId: 'test-nj',
        name: 'Acme New Jersey',
        stateCoverage: ['NJ'],
        keywords: ['election', 'ballot', 'voter'],
        aiBilling: 'operator',
      }),
    }, env)

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.tenantId).toBe('test-nj')

    const db = drizzle(env.DB, { schema })
    const tenant = await db.select().from(schema.tenants)
      .where(eq(schema.tenants.tenantId, 'test-nj')).get()
    expect(tenant?.name).toBe('Acme New Jersey')
    expect(tenant?.ingestionMode).toBe('all')

    const keywords = await db.select().from(schema.keywordRegistry)
      .where(eq(schema.keywordRegistry.tenantId, 'test-nj')).all()
    expect(keywords).toHaveLength(3)
    expect(keywords.map((k) => k.keyword)).toContain('election')
  })

  it('replaces keyword registry on re-registration', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.keywordRegistry).values([
      { tenantId: 'test-va', keyword: 'old-keyword' },
    ])

    const res = await app.request('/tenants/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': 'test-secret' },
      body: JSON.stringify({
        tenantId: 'test-va',
        name: 'Acme Virginia',
        stateCoverage: ['VA'],
        keywords: ['election', 'voting'],
        aiBilling: 'operator',
        ingestionMode: 'keyword-filtered',
      }),
    }, env)

    expect(res.status).toBe(200)

    const tenant = await db.select().from(schema.tenants)
      .where(eq(schema.tenants.tenantId, 'test-va')).get()
    expect(tenant?.ingestionMode).toBe('keyword-filtered')

    const keywords = await db.select().from(schema.keywordRegistry)
      .where(eq(schema.keywordRegistry.tenantId, 'test-va')).all()
    expect(keywords.map((k) => k.keyword)).not.toContain('old-keyword')
    expect(keywords.map((k) => k.keyword)).toContain('election')
  })

  it('returns 400 for missing required fields', async () => {
    const res = await app.request('/tenants/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': 'test-secret' },
      body: JSON.stringify({ tenantId: 'test-org' }),
    }, env)
    expect(res.status).toBe(400)
  })
})
