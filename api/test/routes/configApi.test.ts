import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { env } from 'cloudflare:test'
import { associationConfig, customFieldDefinitions } from '../../src/db/schema'
import { PRESETS } from '../../src/lib/presets'
import { computeMultiState } from '../../src/routes/configApi'
import { app } from '../../src/index'
import { signSuperadminJwt } from '../../../shared/superadminJwt'

// Throwaway ES256 test keypair (no production value); its public half is set as
// SUPERADMIN_JWT_PUBLIC_KEY in vitest.config.mts so signed tokens verify in tests.
// Same keypair used in test/routes/auth.test.ts.
const TEST_SUPERADMIN_PRIV = '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"jMeKJ1Tf0sgE37Rzg02ARwUKvJ2hF6Zy2gI3mluSjpg","y":"vJ0-S0RvpYh3Z87ti61CrBjprBhpmiA4WujS6_Yb_lQ","crv":"P-256","d":"goMnWG7NT0ErjBM6BH8a_rf1hUjMvLB3o3h4f5sE-aY"}'

describe('computeMultiState', () => {
  it('STATE-scoped instance is single-state', () => {
    expect(computeMultiState('RI', JSON.stringify(['RI', 'NJ']))).toBe(false)
  })
  it('no coverage row ⇒ wildcard', () => {
    expect(computeMultiState('', undefined)).toBe(true)
  })
  it('unparseable coverage ⇒ wildcard', () => {
    expect(computeMultiState('', 'not-json')).toBe(true)
  })
  it('wildcard list ⇒ multi', () => {
    expect(computeMultiState('', JSON.stringify(['*']))).toBe(true)
  })
  it('bounded multi list ⇒ multi', () => {
    expect(computeMultiState('', JSON.stringify(['WA', 'US']))).toBe(true)
  })
  it('single-state list ⇒ single', () => {
    expect(computeMultiState('', JSON.stringify(['RI']))).toBe(false)
  })
})

describe('GET /config', () => {
  let cookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'member' })
    const token = await seedSession(userId)
    cookie = `session=${token}`
  })

  it('returns states: [] when no STATE env and no state_coverage row', async () => {
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { states: string[] }
    expect(body.states).toEqual([])
  })

  it('returns states from state_coverage DB row', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'state_coverage',
      value: JSON.stringify(['NJ', 'RI', 'WY', 'WI']),
    })
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { states: string[] }
    expect(body.states).toEqual(['NJ', 'RI', 'WY', 'WI'])
  })

  it('multiState is true when no STATE env and no state_coverage row (wildcard default)', async () => {
    const res = await SELF.fetch('http://localhost/api/config', { headers: { Cookie: cookie } })
    const body = await res.json() as { multiState: boolean }
    expect(body.multiState).toBe(true)
  })

  it('multiState is true for wildcard ["*"] coverage', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'state_coverage', value: JSON.stringify(['*']) })
    const res = await SELF.fetch('http://localhost/api/config', { headers: { Cookie: cookie } })
    const body = await res.json() as { multiState: boolean }
    expect(body.multiState).toBe(true)
  })

  it('multiState is true for a bounded multi-state list', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'state_coverage', value: JSON.stringify(['WA', 'US']) })
    const res = await SELF.fetch('http://localhost/api/config', { headers: { Cookie: cookie } })
    const body = await res.json() as { multiState: boolean }
    expect(body.multiState).toBe(true)
  })

  it('multiState is false for a single-state coverage list', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'state_coverage', value: JSON.stringify(['RI']) })
    const res = await SELF.fetch('http://localhost/api/config', { headers: { Cookie: cookie } })
    const body = await res.json() as { multiState: boolean }
    expect(body.multiState).toBe(false)
  })

  it('returns modules as an empty object when no modules row exists', async () => {
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { modules: Record<string, boolean> }
    expect(body.modules).toEqual({})
  })

  it('returns modules from the modules row when present', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'modules',
      value: JSON.stringify({ 'waiting-for-vote': true }),
    })
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { modules: Record<string, boolean> }
    expect(body.modules).toEqual({ 'waiting-for-vote': true })
  })

  it('returns modules as {} when the stored value is malformed JSON', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'modules',
      value: 'not-json',
    })
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { modules: Record<string, boolean> }
    expect(body.modules).toEqual({})
  })

  it('resolves the operator object from the OPERATOR_* env vars', async () => {
    // Test env (vitest.config.mts) sets OPERATOR_NAME / OPERATOR_URL / OPERATOR_CONTACT_EMAILS.
    const res = await SELF.fetch('http://localhost/api/config', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { operator: { name: string; url: string; contactEmails: string[] } }
    expect(body.operator).toEqual({
      name: 'Test Operator',
      url: 'https://operator.test',
      contactEmails: ['ops@example.test'],
    })
  })

  it('reports demoLocked even for a superadmin request', async () => {
    // The behavior under change: the superadmin exemption is removed, so a
    // superadmin no longer bypasses demo locks. This is the red case.
    const jwtToken = await signSuperadminJwt('super@example.com', 'Super Admin', TEST_SUPERADMIN_PRIV)
    const res = await app.request('/api/config',
      { headers: { Cookie: `${cookie}; superadmin_jwt=${jwtToken}` } },
      { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(200)
    const body = await res.json() as { demoLocked: boolean }
    expect(body.demoLocked).toBe(true)
  })

  it('reports demoLocked for an ordinary request in demo mode', async () => {
    const res = await app.request('/api/config', { headers: { Cookie: cookie } },
      { ...env, DEMO_MODE: 'true' })
    const body = await res.json() as { demoMode: boolean; demoLocked: boolean }
    expect(body.demoMode).toBe(true)
    expect(body.demoLocked).toBe(true)
  })

  it('reports demoLocked false when DEMO_MODE is unset', async () => {
    const res = await app.request('/api/config', { headers: { Cookie: cookie } }, env)
    const body = await res.json() as { demoLocked: boolean }
    expect(body.demoLocked).toBe(false)
  })

  it('returns demoBanner from config', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'demo_banner', value: JSON.stringify('Test banner') })
    const res = await app.request('/api/config', { headers: { Cookie: cookie } }, { ...env, DEMO_MODE: 'true' })
    const body = await res.json() as { demoBanner?: string }
    expect(body.demoBanner).toBe('Test banner')
  })

  // ── INSTANCE_PRESET must never touch a demo tenant's seed-written config ───
  //
  // A demo tenant's ai_context / relevance_question / tag_taxonomy / keywords
  // come from its seed (api/src/lib/demoSeeds/), and the demo reset writes no
  // instance_preset row. Because self-hosting/tenants.md recommends setting
  // INSTANCE_PRESET on every tenant and self-hosting/demo.md says to deploy a
  // demo "exactly as in Adding tenants", a fresh demo tenant would otherwise hit
  // ensureInstancePreset's bootstrap branch on its very first GET /config and
  // have all four keys overwritten with preset values — silently, and only until
  // the next reset.

  /** Write the four keys a seed owns, as runDemoReset would. */
  async function seedWrittenAiConfig(db: ReturnType<typeof getDb>) {
    for (const [key, value] of [
      ['ai_context', JSON.stringify('Seed AI context for county clerks.')],
      ['relevance_question', JSON.stringify('Seed relevance question?')],
      ['tag_taxonomy', JSON.stringify([{ name: 'Seed Tag', description: 'From the demo seed' }])],
      ['keywords', JSON.stringify(['seed-keyword'])],
    ] as const) {
      await db.insert(associationConfig).values({ key, value })
        .onConflictDoUpdate({ target: associationConfig.key, set: { value } })
    }
  }

  async function configRow(db: ReturnType<typeof getDb>, key: string): Promise<string | undefined> {
    const row = await db.select().from(associationConfig).where(eq(associationConfig.key, key)).get()
    return row?.value
  }

  it('leaves a demo tenant\'s seed-written config alone even with INSTANCE_PRESET set', async () => {
    const db = getDb(env.DB)
    await seedWrittenAiConfig(db)

    const res = await app.request('/api/config', { headers: { Cookie: cookie } },
      { ...env, DEMO_MODE: 'true', INSTANCE_PRESET: 'election_officials' })
    expect(res.status).toBe(200)

    expect(await configRow(db, 'ai_context')).toBe(JSON.stringify('Seed AI context for county clerks.'))
    expect(await configRow(db, 'relevance_question')).toBe(JSON.stringify('Seed relevance question?'))
    expect(await configRow(db, 'tag_taxonomy')).toBe(JSON.stringify([{ name: 'Seed Tag', description: 'From the demo seed' }]))
    expect(await configRow(db, 'keywords')).toBe(JSON.stringify(['seed-keyword']))
    // and no preset row is bootstrapped into existence either
    expect(await configRow(db, 'instance_preset')).toBeUndefined()
  })

  it('still applies INSTANCE_PRESET on a non-demo tenant', async () => {
    const db = getDb(env.DB)
    await seedWrittenAiConfig(db)

    const res = await app.request('/api/config', { headers: { Cookie: cookie } },
      { ...env, DEMO_MODE: undefined, INSTANCE_PRESET: 'election_officials' })
    expect(res.status).toBe(200)

    expect(await configRow(db, 'instance_preset')).toBe(JSON.stringify('election_officials'))
    const preset = PRESETS.election_officials
    expect(await configRow(db, 'ai_context')).toBe(JSON.stringify(preset.aiContext))
    expect(await configRow(db, 'relevance_question')).toBe(JSON.stringify(preset.relevanceQuestion))
    expect(await configRow(db, 'tag_taxonomy')).toBe(JSON.stringify(preset.taxonomy))
    expect(await configRow(db, 'keywords')).toBe(JSON.stringify(preset.keywords))
  })
})

describe('PUT /admin/config', () => {
  let cookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    // requireAdmin gates the whole /admin/* router, so this needs an
    // admin-or-owner session — unlike the plain-member cookie GET /config uses.
    const userId = await seedUser({ role: 'owner' })
    const token = await seedSession(userId)
    cookie = `session=${token}`
  })

  it('rejects a non-modules key for a superadmin request, same as any other request', async () => {
    // Mirrors "reports demoLocked even for a superadmin request" above, but for
    // the second exemption-removal site: PUT /admin/config self-limits to
    // modules-only in demo mode, and a superadmin JWT must not bypass that
    // either. association_name is a real ALLOWED_CONFIG_KEYS entry (a key not
    // on that list would 400 on the unknown-key check before ever reaching the
    // demo lock, which would pass this test for the wrong reason).
    const jwtToken = await signSuperadminJwt('super@example.com', 'Super Admin', TEST_SUPERADMIN_PRIV)
    const res = await app.request('/api/admin/config', {
      method: 'PUT',
      headers: { Cookie: `${cookie}; superadmin_jwt=${jwtToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ association_name: 'Hacked' }),
    }, { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Configuration is locked in demo mode' })
  })
})

describe('GET /config orgNoun', () => {
  let cookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'member' })
    const token = await seedSession(userId)
    cookie = `session=${token}`
  })

  it('GET /config resolves orgNoun from org_noun key', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'org_noun',
      value: JSON.stringify('coalition'),
    })
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { orgNoun: string }
    expect(body.orgNoun).toBe('coalition')
  })

  it('GET /config falls back to position_label first word', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'position_label',
      value: JSON.stringify('Association position'),
    })
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { orgNoun: string }
    expect(body.orgNoun).toBe('association')
  })

  it('GET /config defaults orgNoun to team', async () => {
    const res = await SELF.fetch('http://localhost/api/config', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { orgNoun: string }
    expect(body.orgNoun).toBe('team')
  })
})

describe('GET /config/sessions', () => {
  let cookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'member' })
    const token = await seedSession(userId)
    cookie = `session=${token}`
  })

  it('returns 400 when state param is missing', async () => {
    const res = await SELF.fetch('http://localhost/api/config/sessions', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(400)
  })

  it('proxies to central and returns sessions', async () => {
    const mockSessions = [
      { session_id: 1, session_name: '2025-2026 Regular Session', year_start: 2025, year_end: 2026 },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: mockSessions }),
    }))

    const res = await SELF.fetch('http://localhost/api/config/sessions?state=NJ', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: typeof mockSessions }
    expect(body.sessions).toEqual(mockSessions)
  })

  it('returns sessions: [] when central returns an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'error' }))
    const res = await SELF.fetch('http://localhost/api/config/sessions?state=NJ', {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })
})

describe('GET /config/custom-fields', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('returns pinned: false by default for a newly created field', async () => {
    const db = getDb(env.DB)
    await db.insert(customFieldDefinitions).values({
      id: 'field-1',
      name: 'Fiscal Note',
      slug: 'fiscal_note',
      type: 'text',
      options: null,
      displayOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const userId = await seedUser({ role: 'member' })
    const memberToken = await seedSession(userId)
    const res = await SELF.fetch('http://localhost/api/config/custom-fields', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const fields = await res.json() as { id: string; pinned: boolean }[]
    expect(fields).toHaveLength(1)
    expect(fields[0].pinned).toBe(false)
  })
})
