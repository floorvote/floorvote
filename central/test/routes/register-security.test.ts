import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { eq } from 'drizzle-orm'

const AUTH = { 'x-admin-secret': 'sek', 'content-type': 'application/json' }
const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }

beforeEach(async () => { await setupLsDb() })

async function register(body: object, envOverride?: any) {
  return app.fetch(
    new Request('http://central/api/tenants/register', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(body),
    }),
    envOverride ?? TEST_ENV,
  )
}

async function tenantRow(tenantId: string) {
  const db = drizzle(env.DB, { schema })
  return db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, tenantId)).get()
}

// ── H3: apiUrl validation ──────────────────────────────────────────────────

describe('POST /tenants/register — apiUrl validation (H3)', () => {
  it('accepts a valid https URL and writes the row', async () => {
    const res = await register({ tenantId: 'ri', name: 'RI', apiUrl: 'https://ri.example.com', stateCoverage: ['RI'] })
    expect(res.status).toBe(200)
    const row = await tenantRow('ri')
    expect(row).toBeTruthy()
    expect(row!.apiUrl).toBe('https://ri.example.com')
  })

  it('rejects http:// and writes no row', async () => {
    const res = await register({ tenantId: 'http-test', name: 'X', apiUrl: 'http://ri.example.com', stateCoverage: [] })
    expect(res.status).toBe(400)
    const row = await tenantRow('http-test')
    expect(row).toBeUndefined()
  })

  it('rejects https://localhost and writes no row', async () => {
    const res = await register({ tenantId: 'local-test', name: 'X', apiUrl: 'https://localhost', stateCoverage: [] })
    expect(res.status).toBe(400)
    const row = await tenantRow('local-test')
    expect(row).toBeUndefined()
  })

  it('rejects https://127.0.0.1 and writes no row', async () => {
    const res = await register({ tenantId: 'loop-test', name: 'X', apiUrl: 'https://127.0.0.1', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('loop-test')).toBeUndefined()
  })

  it('rejects https://[::1] IPv6 loopback and writes no row', async () => {
    const res = await register({ tenantId: 'ipv6-test', name: 'X', apiUrl: 'https://[::1]', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('ipv6-test')).toBeUndefined()
  })

  it('rejects http://169.254.169.254 AWS metadata and writes no row', async () => {
    const res = await register({ tenantId: 'meta-test', name: 'X', apiUrl: 'http://169.254.169.254', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('meta-test')).toBeUndefined()
  })

  it('rejects https://10.0.0.1 private IP and writes no row', async () => {
    const res = await register({ tenantId: 'private-test', name: 'X', apiUrl: 'https://10.0.0.1', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('private-test')).toBeUndefined()
  })

  it('rejects https://foo.local and writes no row', async () => {
    const res = await register({ tenantId: 'dotlocal-test', name: 'X', apiUrl: 'https://foo.local', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('dotlocal-test')).toBeUndefined()
  })

  it('rejects bare hostname (no dot) and writes no row', async () => {
    const res = await register({ tenantId: 'bare-test', name: 'X', apiUrl: 'https://internal', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('bare-test')).toBeUndefined()
  })

  it('rejects missing apiUrl and writes no row', async () => {
    const res = await register({ tenantId: 'no-url', name: 'X', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('no-url')).toBeUndefined()
  })

  it('rejects malformed string and writes no row', async () => {
    const res = await register({ tenantId: 'bad-url', name: 'X', apiUrl: 'not-a-url', stateCoverage: [] })
    expect(res.status).toBe(400)
    expect(await tenantRow('bad-url')).toBeUndefined()
  })

  it('returns an error message in the response body', async () => {
    const res = await register({ tenantId: 'err-msg', name: 'X', apiUrl: 'http://ri.example.com', stateCoverage: [] })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBeTruthy()
  })
})

// ── H3 (regression): valid re-register preserves state_coverage merge ──────

describe('POST /tenants/register — state_coverage merge still works after H3 fix', () => {
  it('valid re-register merges coverage rather than overwriting', async () => {
    await register({ tenantId: 'cov', name: 'Cov', apiUrl: 'https://ri.example.com', stateCoverage: ['NJ', 'RI'] })
    await register({ tenantId: 'cov', name: 'Cov', apiUrl: 'https://ri.example.com', stateCoverage: ['CA'] })
    const row = await tenantRow('cov')
    expect(JSON.parse(row!.stateCoverage)).toEqual(['NJ', 'RI', 'CA'])
  })
})

// ── H4: cross-tenant re-homing mitigation ─────────────────────────────────

describe('POST /tenants/register — apiUrl re-homing protection (H4)', () => {
  it('rejects a re-register that changes the origin to a different domain', async () => {
    // First registration
    await register({ tenantId: 'ri', name: 'RI', apiUrl: 'https://ri.example.com', stateCoverage: ['RI'] })

    // Attacker tries to point the same tenantId at a different origin
    const res = await register({ tenantId: 'ri', name: 'RI-hijacked', apiUrl: 'https://evil.example.com', stateCoverage: ['RI'] })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)

    // Stored apiUrl must be unchanged
    const row = await tenantRow('ri')
    expect(row!.apiUrl).toBe('https://ri.example.com')
  })

  it('allows re-register with the same origin (update name / add states)', async () => {
    await register({ tenantId: 'ri', name: 'RI', apiUrl: 'https://ri.example.com', stateCoverage: ['RI'] })
    const res = await register({ tenantId: 'ri', name: 'RI Updated', apiUrl: 'https://ri.example.com', stateCoverage: ['PA'] })
    expect(res.status).toBe(200)

    const row = await tenantRow('ri')
    // Name updated
    expect(row!.name).toBe('RI Updated')
    // Coverage merged (RI + PA)
    expect(JSON.parse(row!.stateCoverage)).toEqual(expect.arrayContaining(['RI', 'PA']))
  })

  it('allows re-register with same origin but different path/trailing-slash variants', async () => {
    await register({ tenantId: 'ri', name: 'RI', apiUrl: 'https://ri.example.com', stateCoverage: ['RI'] })
    // Same hostname, different path — same origin, should be allowed
    const res = await register({ tenantId: 'ri', name: 'RI', apiUrl: 'https://ri.example.com/api', stateCoverage: ['RI'] })
    expect(res.status).toBe(200)
  })

  it('first-time registration (no existing row) always succeeds with a valid URL', async () => {
    const res = await register({ tenantId: 'brand-new', name: 'New', apiUrl: 'https://new.example.com', stateCoverage: ['MA'] })
    expect(res.status).toBe(200)
    const row = await tenantRow('brand-new')
    expect(row!.apiUrl).toBe('https://new.example.com')
  })
})
