import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { registerWithCentral } from '../../src/cron/sync'
import { associationConfig } from '../../src/db/schema'

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

  it('auto-applies INSTANCE_PRESET before registering', async () => {
    const db = getDb(env.DB)
    await registerWithCentral({ ...testEnv, INSTANCE_PRESET: 'election_officials' } as any, db)

    const body = JSON.parse(fetchCalls[0].options.body as string)
    expect(body.keywords.length).toBeGreaterThan(0)

    const presetRow = await db.select().from(associationConfig).all()
    const instancePresetRow = presetRow.find((row) => row.key === 'instance_preset')
    expect(instancePresetRow).toBeDefined()
    expect(JSON.parse(instancePresetRow!.value)).toBe('election_officials')
  })

  it('does not throw if central returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    const db = getDb(env.DB)
    await expect(registerWithCentral(testEnv as any, db)).resolves.not.toThrow()
  })
})
