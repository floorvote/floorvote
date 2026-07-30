import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { env } from 'cloudflare:test'
import { associationConfig, customFieldDefinitions } from '../../src/db/schema'
import { computeMultiState } from '../../src/routes/configApi'

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
