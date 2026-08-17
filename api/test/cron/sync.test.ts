import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { registerWithCentral } from '../../src/cron/sync'
import { associationConfig } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

const testEnv = {
  ...env,
  TENANT_ID: 'test-org',
  CENTRAL_API_URL: 'https://central.test',
  ASSOCIATION_NAME: 'Test Association',
  STATE: 'NJ',
}

describe('registerWithCentral', () => {
  let fetchCalls: { url: string; options: RequestInit }[] = []

  beforeEach(async () => {
    await applyMigrations()
    fetchCalls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      fetchCalls.push({ url, options })
      return { ok: true, json: async () => ({ success: true }) }
    }))
  })

  it('calls central /tenants/register with tenant_id and keywords', async () => {
    const db = getDb(env.DB)
    await registerWithCentral(testEnv as any, db)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('https://central.test/api/tenants/register')
    const body = JSON.parse(fetchCalls[0].options.body as string)
    expect(body.tenantId).toBe('test-org')
    expect(Array.isArray(body.keywords)).toBe(true)
    expect(body.keywords).toEqual([])
  })

  it('uses keywords from association_config when set', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values([
      { key: 'keywords', value: JSON.stringify(['ballot', 'voter']) },
      { key: 'state_coverage', value: JSON.stringify(['NJ', 'PA']) },
    ])
    await registerWithCentral(testEnv as any, db)
    const body = JSON.parse(fetchCalls[0].options.body as string)
    expect(body.keywords).toEqual(['ballot', 'voter'])
    expect(body.stateCoverage).toEqual(['NJ', 'PA'])
  })

  // Registration runs the association_name bootstrap first, so a tenant's very first
  // cron tick leaves the name set rather than on the migration placeholder. This used
  // to ride along on the preset bootstrap, which is why it is asserted here.
  it('seeds association_name from env before registering', async () => {
    const db = getDb(env.DB)
    await registerWithCentral(testEnv as any, db)

    const nameRow = await db.select().from(associationConfig)
      .where(eq(associationConfig.key, 'association_name')).get()
    expect(nameRow).toBeDefined()
    expect(JSON.parse(nameRow!.value)).toBe('Test Association')
  })

  it('does not throw if central returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    const db = getDb(env.DB)
    await expect(registerWithCentral(testEnv as any, db)).resolves.not.toThrow()
  })

  it('reports aiContextPersonalized: false when ai_context is unset', async () => {
    const db = getDb(env.DB)
    await registerWithCentral(testEnv as any, db)
    const body = JSON.parse(fetchCalls[0].options.body as string)
    expect(body.aiContextPersonalized).toBe(false)
  })

  it('reports whether ai_context has been personalized', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'ai_context',
      value: JSON.stringify('Analyze for county clerks.'),
    }).onConflictDoUpdate({
      target: associationConfig.key,
      set: { value: JSON.stringify('Analyze for county clerks.') },
    })

    await registerWithCentral(testEnv as any, db)

    const body = JSON.parse(fetchCalls[0].options.body as string)
    expect(body.aiContextPersonalized).toBe(true)
  })
})
