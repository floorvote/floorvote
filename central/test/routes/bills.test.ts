import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import { openStatesMigrations, setupDb } from '../helpers/migrations'

beforeEach(async () => {
  await setupDb(openStatesMigrations)
})

describe('GET /bills/:id', () => {
  it('returns full bill data for an existing bill', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'nj:222', state: 'NJ', identifier: '222',
      yearStart: 2026, yearEnd: 2027, sessionName: '2026 Session',
      isCurrent: true, sineDie: false,
    })

    const providerData = JSON.stringify({
      versions: [{ id: 'ver-50', note: 'Introduced', date: '2026-01-01', links: [] }],
      actions: [{ description: 'Introduced', date: '2026-01-01', chamber: 'lower', classification: ['introduction'], order: 1 }],
      sponsors: [{ name: 'Smith', party: 'D', role: null, primary: true, personId: null }],
      documents: [],
      votes: [],
      relatedBills: [],
    })

    await db.insert(schema.bills).values({
      billId: 'ocd-bill/abc123', sessionId: 'nj:222', state: 'NJ', number: 'A1',
      title: 'Election Law Reform', providerData,
      textR2Key: 'bills/abc123/ver-50.html',
    })

    const res = await app.request('/bills/ocd-bill/abc123', { headers: { 'x-admin-secret': 'test-secret' } }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.billId).toBe('ocd-bill/abc123')
    expect(body.texts).toHaveLength(1)
    expect(body.texts[0].docId).toBe('ver-50')
    expect(body.sponsors).toHaveLength(1)
    expect(body.actions).toHaveLength(1)
  })

  it('returns 404 for unknown bill', async () => {
    const res = await app.request('/bills/ocd-bill/nonexistent', { headers: { 'x-admin-secret': 'test-secret' } }, env)
    expect(res.status).toBe(404)
  })
})
