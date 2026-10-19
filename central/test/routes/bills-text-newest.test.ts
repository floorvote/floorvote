import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

beforeEach(async () => {
  await clearDb()
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({
    sessionId: 1, state: 'VA', stateId: 46, yearStart: 2026, yearEnd: 2026, sessionName: 'VA 2026', sessionTitle: 'Regular',
  })
  await db.insert(schema.bills).values({
    billId: 300, sessionId: 1, state: 'VA', stateId: 46, billNumber: 'HB1', title: 'Bill 300', changeHash: 'h', status: 1,
  })
})

type Seed = { docId: number; date: string; inR2: boolean }

// Insert in the order given, so a test controls row order independently of doc id.
async function seedTexts(texts: Seed[]) {
  const db = drizzle(env.DB, { schema })
  for (const t of texts) {
    await db.insert(schema.billTexts).values({
      docId: t.docId, billId: 300, date: t.date, type: 'Text',
      textHash: `hash-${t.docId}`, r2Key: t.inR2 ? `bills/300/${t.docId}.html` : null,
    })
    if (t.inR2) await env.BILLS_BUCKET.put(`bills/300/${t.docId}.html`, `<p>doc ${t.docId}</p>`)
  }
}

async function getBill() {
  const res = await app.request('/api/bills/300', { headers: { 'x-admin-secret': 'test-secret' } }, env)
  expect(res.status).toBe(200)
  return await res.json() as { textHash: string | null; textR2Key: string | null; textStatus: string }
}

async function getText() {
  // The route caches in waitUntil, which needs an execution context.
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
  const res = await app.request('/api/bills/300/text', { headers: { 'x-admin-secret': 'test-secret' } }, env, ctx)
  return { status: res.status, body: res.status === 200 ? await res.json() as { content: string } : null }
}

describe('newest bill text when versions share a date', () => {
  it('serves the higher doc id when the older version was stored last', async () => {
    await seedTexts([
      { docId: 20, date: '2026-03-01', inR2: true },
      { docId: 10, date: '2026-03-01', inR2: true },
    ])
    expect(await getBill()).toMatchObject({ textHash: 'hash-20', textR2Key: 'bills/300/20.html' })
  })

  it('serves the higher doc id when the newer version was stored last', async () => {
    await seedTexts([
      { docId: 10, date: '2026-03-01', inR2: true },
      { docId: 20, date: '2026-03-01', inR2: true },
    ])
    expect(await getBill()).toMatchObject({ textHash: 'hash-20', textR2Key: 'bills/300/20.html' })
  })

  it('lets the newest date win even when its doc id is lower', async () => {
    await seedTexts([
      { docId: 20, date: '2026-03-01', inR2: true },
      { docId: 10, date: '2026-03-02', inR2: true },
    ])
    expect(await getBill()).toMatchObject({ textHash: 'hash-10', textR2Key: 'bills/300/10.html' })
  })

  it('serves the lower doc id when only it is in R2', async () => {
    await seedTexts([
      { docId: 20, date: '2026-03-01', inR2: false },
      { docId: 10, date: '2026-03-01', inR2: true },
    ])
    expect(await getBill()).toMatchObject({ textHash: 'hash-10', textR2Key: 'bills/300/10.html', textStatus: 'in_r2' })
  })

  it('reads the same version through the text route as the hash it sends', async () => {
    await seedTexts([
      { docId: 20, date: '2026-03-02', inR2: true },
      { docId: 30, date: '2026-03-01', inR2: true },
    ])
    expect(await getBill()).toMatchObject({ textHash: 'hash-20' })
    expect(await getText()).toMatchObject({ status: 200, body: { content: '<p>doc 20</p>' } })
  })
})
