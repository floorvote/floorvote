import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

// The bill route sends each listed text with its own hash (#603), so an
// instance can store it per document and tell a text that changed under the
// same doc id from one that did not. It is the stored `text_hash`, the same
// value `GET /bills/:id/text` serves for the document the model reads.

const BILL = 500

beforeEach(async () => {
  await setupLsDb()
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({
    sessionId: 1, state: 'ZZ', stateId: 99, yearStart: 2026, yearEnd: 2026, sessionName: 'ZZ 2026', sessionTitle: 'Regular',
  })
  await db.insert(schema.bills).values({
    billId: BILL, sessionId: 1, state: 'ZZ', stateId: 99, billNumber: 'HB5', title: 'Bill 500', changeHash: 'h', status: 1,
  })
})

type Seed = { docId: number; date: string; textHash: string | null; inR2?: boolean }

async function seed(texts: Seed[]) {
  const db = drizzle(env.DB, { schema })
  for (const t of texts) {
    const inR2 = t.inR2 ?? true
    await db.insert(schema.billTexts).values({
      docId: t.docId, billId: BILL, date: t.date, type: 'Text', textHash: t.textHash,
      r2Key: inR2 ? `bills/legiscan-${BILL}/texts/${t.docId}.html` : null,
    })
    if (inR2) await env.BILLS_BUCKET.put(`bills/legiscan-${BILL}/texts/${t.docId}.html`, `<p>doc ${t.docId}</p>`)
  }
}

const ctx = () => ({ waitUntil: () => {}, passThroughOnException: () => {} }) as unknown as ExecutionContext

async function getBill() {
  const res = await app.request(`/api/bills/${BILL}`, { headers: { 'x-admin-secret': 'test-secret' } }, env, ctx())
  expect(res.status).toBe(200)
  return await res.json() as { textHash: string | null; texts: { docId: string; textHash?: string | null }[] }
}

async function getText() {
  const res = await app.request(`/api/bills/${BILL}/text`, { headers: { 'x-admin-secret': 'test-secret' } }, env, ctx())
  return await res.json() as { docId: string; textHash: string | null }
}

describe('each listed text carries its own hash', () => {
  it('sends every document\'s stored hash, not just the newest\'s', async () => {
    await seed([
      { docId: 11, date: '2026-01-01', textHash: 'hash-11' },
      { docId: 12, date: '2026-02-01', textHash: 'hash-12' },
    ])
    const { texts } = await getBill()
    expect(Object.fromEntries(texts.map(t => [t.docId, t.textHash]))).toEqual({ '11': 'hash-11', '12': 'hash-12' })
  })

  it('sends the new hash for a document whose text changed under the same doc id', async () => {
    await seed([{ docId: 13, date: '2026-01-01', textHash: 'hash-13-v1' }])
    expect((await getBill()).texts[0].textHash).toBe('hash-13-v1')
    await drizzle(env.DB, { schema }).update(schema.billTexts).set({ textHash: 'hash-13-v2' })
    expect((await getBill()).texts[0]).toMatchObject({ docId: '13', textHash: 'hash-13-v2' })
  })

  it('sends a hash for a document with no stored copy, which is how it is stored', async () => {
    await seed([{ docId: 14, date: '2026-01-01', textHash: 'hash-14', inR2: false }])
    expect((await getBill()).texts[0].textHash).toBe('hash-14')
  })

  it('sends null for a document with no hash', async () => {
    await seed([{ docId: 15, date: '2026-01-01', textHash: null }])
    expect((await getBill()).texts[0].textHash).toBeNull()
  })

  it('keeps the doc id a string and the bill-level hash as it was', async () => {
    await seed([{ docId: 16, date: '2026-01-01', textHash: 'hash-16' }])
    const bill = await getBill()
    expect(bill.texts[0].docId).toBe('16')
    expect(bill.textHash).toBe('hash-16')
  })

  it('agrees with the hash the text route serves for the document the model reads', async () => {
    await seed([
      { docId: 21, date: '2026-01-01', textHash: 'hash-21' },
      { docId: 22, date: '2026-02-01', textHash: 'hash-22' },
    ])
    const served = await getText()
    const listed = (await getBill()).texts.find(t => t.docId === served.docId)
    expect(served.docId).toBe('22')
    expect(listed?.textHash).toBe(served.textHash)
  })

  it('is stable across requests', async () => {
    await seed([{ docId: 31, date: '2026-01-01', textHash: 'hash-31' }])
    expect((await getBill()).texts).toEqual((await getBill()).texts)
  })
})
