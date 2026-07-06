import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

async function adminPost(path: string, body: unknown, token: string) {
  return SELF.fetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /calendar/import', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const admin = await seedUser({ email: 'admin@b.com', role: 'admin' })
    adminToken = await seedSession(admin)
  })

  const rows = [
    { title: 'Filing period', date: '2026-05-14', details: 'Through May 29', time: null, location: null, url: null },
    { title: 'No date row', date: '', details: null, time: null, location: null, url: null },
  ]

  it('requires auth', async () => {
    const r = await SELF.fetch('http://localhost/api/calendar/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows }),
    })
    expect(r.status).toBe(401)
  })

  it('requires admin', async () => {
    const member = await seedUser({ email: 'm@b.com', role: 'member' })
    const memberToken = await seedSession(member)
    const r = await SELF.fetch('http://localhost/api/calendar/import', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ rows }),
    })
    expect(r.status).toBe(403)
  })

  it('does not crash on a non-string or invalid url', async () => {
    const res = await adminPost('/api/calendar/import', { rows: [
      { title: 'Numeric url', date: '2026-06-01', details: null, time: null, location: null, url: 12345 },
      { title: 'Bad scheme', date: '2026-06-02', details: null, time: null, location: null, url: 'ftp://x' },
    ] }, adminToken)
    expect(res.status).toBe(200)
    const j = await res.json() as any
    expect(j.created).toBe(2)   // both rows created; bad urls just dropped to null
  })

  it('rejects payloads with more than 1000 rows with 413', async () => {
    const bigRows = Array.from({ length: 1001 }, (_, i) => ({
      title: `Event ${i}`, date: '2026-05-14', details: null, time: null, location: null, url: null,
    }))
    const r = await adminPost('/api/calendar/import', { rows: bigRows }, adminToken)
    expect(r.status).toBe(413)
    const j = await r.json() as any
    expect(j.ok).toBe(false)
    expect(j.error).toMatch(/1000/)
  })

  it('accepts a payload with exactly 1000 rows without 413', async () => {
    const exactRows = Array.from({ length: 1000 }, (_, i) => ({
      title: `Event ${i}`, date: '2026-05-14', details: null, time: null, location: null, url: null,
    }))
    const r = await adminPost('/api/calendar/import', { rows: exactRows }, adminToken)
    expect(r.status).toBe(200)
  })

  it('creates valid rows, skips invalid, and is idempotent', async () => {
    const r1 = await adminPost('/api/calendar/import', { rows }, adminToken)
    expect(r1.status).toBe(200)
    const j1 = await r1.json() as any
    expect(j1.created).toBe(1)
    expect(j1.skipped).toBe(1)

    const r2 = await adminPost('/api/calendar/import', { rows }, adminToken)
    const j2 = await r2.json() as any
    expect(j2.created).toBe(0)       // same content → no new row
    expect(j2.unchanged).toBe(1)     // valid row with matching hash
    expect(j2.skipped).toBe(1)

    const r3 = await adminPost('/api/calendar/import', { rows: [{ ...rows[0], details: 'Through May 30' }] }, adminToken)
    const j3 = await r3.json() as any
    expect(j3.updated).toBe(1)   // content changed → updated
  })
})
