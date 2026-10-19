import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

// GET /bills/:id/text names the document it served (#568). Instances pin each
// bill's claim sources to the document the model read, which is this one, so
// the endpoint returns its doc id and text hash beside `type` and `content`.

const BILL = 400

beforeEach(async () => {
  await clearDb()
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({
    sessionId: 1, state: 'ZZ', stateId: 99, yearStart: 2026, yearEnd: 2026, sessionName: 'ZZ 2026', sessionTitle: 'Regular',
  })
  await db.insert(schema.bills).values({
    billId: BILL, sessionId: 1, state: 'ZZ', stateId: 99, billNumber: 'HB4', title: 'Bill 400', changeHash: 'h', status: 1,
  })
})

type Seed = { docId: number; date: string; ext?: 'html' | 'pdf'; inR2?: boolean; textHash?: string | null; body?: string }

async function seed(texts: Seed[]) {
  const db = drizzle(env.DB, { schema })
  for (const t of texts) {
    const ext = t.ext ?? 'html'
    const r2Key = `bills/legiscan-${BILL}/texts/${t.docId}.${ext}`
    const inR2 = t.inR2 ?? true
    await db.insert(schema.billTexts).values({
      docId: t.docId, billId: BILL, date: t.date, type: 'Text',
      textHash: t.textHash === undefined ? `hash-${t.docId}` : t.textHash,
      r2Key: inR2 ? r2Key : null,
    })
    if (inR2) await env.BILLS_BUCKET.put(r2Key, t.body ?? (ext === 'pdf' ? '%PDF-1.4 fake' : `<p>doc ${t.docId}</p>`))
  }
}

const ctx = () => ({ waitUntil: () => {}, passThroughOnException: () => {} }) as unknown as ExecutionContext

async function getText() {
  const res = await app.request(`/api/bills/${BILL}/text`, { headers: { 'x-admin-secret': 'test-secret' } }, env, ctx())
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function getBill() {
  const res = await app.request(`/api/bills/${BILL}`, { headers: { 'x-admin-secret': 'test-secret' } }, env, ctx())
  return await res.json() as { textHash: string | null; textR2Key: string | null }
}

describe('GET /bills/:id/text names the document it served', () => {
  it('returns the doc id, as a string, and text hash of an HTML document', async () => {
    await seed([{ docId: 41, date: '2026-03-01' }])
    expect(await getText()).toEqual({
      status: 200,
      body: { type: 'html', content: '<p>doc 41</p>', docId: '41', textHash: 'hash-41' },
    })
  })

  it('returns the doc id and text hash of a PDF document', async () => {
    await seed([{ docId: 42, date: '2026-03-01', ext: 'pdf' }])
    const { status, body } = await getText()
    expect(status).toBe(200)
    expect(body).toMatchObject({ type: 'pdf', docId: '42', textHash: 'hash-42' })
    expect(atob(body.content as string)).toBe('%PDF-1.4 fake')
  })

  it('names the document it served, not a newer one with no stored copy', async () => {
    await seed([
      { docId: 50, date: '2026-03-01' },
      { docId: 60, date: '2026-04-01', inR2: false },
    ])
    expect((await getText()).body).toMatchObject({ content: '<p>doc 50</p>', docId: '50', textHash: 'hash-50' })
  })

  it('names the same document the bill route sends the hash and key of', async () => {
    await seed([
      { docId: 70, date: '2026-03-01' },
      { docId: 71, date: '2026-03-01' },
      { docId: 65, date: '2026-02-01' },
    ])
    const bill = await getBill()
    const { body } = await getText()
    expect(body.docId).toBe('71')
    expect(body.textHash).toBe(bill.textHash)
    expect(bill.textR2Key).toBe(`bills/legiscan-${BILL}/texts/71.html`)
  })

  it('sends a null hash for a document with none', async () => {
    await seed([{ docId: 80, date: '2026-03-01', textHash: null }])
    expect((await getText()).body).toMatchObject({ docId: '80', textHash: null })
  })

  it('does not serve a copy cached before the endpoint named its document', async () => {
    await seed([{ docId: 90, date: '2026-03-01' }])
    // The key the JSON variant used before this change, holding a body in the old shape.
    const oldKey = new Request(`https://bill-text-cache.internal/json/${encodeURIComponent(`bills/legiscan-${BILL}/texts/90.html`)}`)
    await caches.default.put(oldKey, new Response(JSON.stringify({ type: 'html', content: '<p>doc 90</p>' }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
    }))
    expect((await getText()).body).toMatchObject({ docId: '90', textHash: 'hash-90' })
  })

  it('still answers 404 when no document has a stored copy', async () => {
    await seed([{ docId: 95, date: '2026-03-01', inR2: false }])
    expect(await getText()).toEqual({ status: 404, body: { error: 'no text available' } })
  })
})
