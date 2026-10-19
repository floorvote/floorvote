import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

// Both endpoints read the same R2 object: GET /bills/:id/text (JSON, read by the
// analysis path) and GET /bills/:id/text/:docId (inline, read by the bill text panel).

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

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const headers = { 'x-admin-secret': 'test-secret' }

// One byte per code unit, so a fixture reads as the exact bytes a windows-1252 server sent.
function raw(s: string): Uint8Array {
  return Uint8Array.from(s, ch => ch.charCodeAt(0))
}

// 0x93/0x94 curly double quotes, 0x92 apostrophe, 0x96 en dash, 0xA7 section sign.
const CP1252_BODY = '<p>\x93Sample Act\x94 \xA7 12\x9613 isn\x92t binding.</p>'
const CP1252_DECODED = '<p>“Sample Act” § 12–13 isn’t binding.</p>'

let nextDocId = 1000

/** Store `bytes` as the bill's only text and return what each endpoint serves. */
async function serve(bytes: Uint8Array, contentType: string | undefined, ext: 'html' | 'pdf' = 'html') {
  const docId = nextDocId++
  const r2Key = `bills/legiscan-300/texts/${docId}.${ext}`
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.billTexts).values({
    docId, billId: 300, date: '2026-03-01', type: 'Text', textHash: `hash-${docId}`, r2Key,
    mime: ext === 'pdf' ? 'application/pdf' : 'text/html',
  })
  await env.BILLS_BUCKET.put(r2Key, bytes, contentType ? { httpMetadata: { contentType } } : undefined)

  const jsonRes = await app.request('/api/bills/300/text', { headers }, env, ctx)
  const inlineRes = await app.request(`/api/bills/300/text/${docId}`, { headers }, env, ctx)
  return {
    json: await jsonRes.json() as { type: string; content: string },
    inlineStatus: inlineRes.status,
    inlineType: inlineRes.headers.get('content-type'),
    inlineBytes: new Uint8Array(await inlineRes.arrayBuffer()),
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const asText = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b)

describe('stored HTML bill text decoding', () => {
  it('serves undeclared windows-1252 bytes as characters, not U+FFFD, to the analysis path and the panel', async () => {
    const r = await serve(raw(CP1252_BODY), 'text/html')
    // The decoded text comes pinned to the document it was read from (#568), so
    // claim sources quote the same characters a reader sees.
    expect(r.json).toEqual({ type: 'html', content: CP1252_DECODED, docId: expect.any(String), textHash: expect.any(String) })
    expect(r.inlineStatus).toBe(200)
    expect(asText(r.inlineBytes)).toBe(CP1252_DECODED)
    expect(r.json.content).not.toContain('�')
  })

  it('serves windows-1252 text with no stored content type at all', async () => {
    const r = await serve(raw(CP1252_BODY), undefined)
    expect(r.json.content).toBe(CP1252_DECODED)
    expect(asText(r.inlineBytes)).toBe(CP1252_DECODED)
  })

  it('serves windows-1252 text declared by <meta charset>', async () => {
    const html = `<head><meta charset="windows-1252"></head>${CP1252_BODY}`
    const expected = `<head><meta charset="windows-1252"></head>${CP1252_DECODED}`
    const r = await serve(raw(html), 'text/html')
    expect(r.json.content).toBe(expected)
    expect(asText(r.inlineBytes)).toBe(expected)
  })

  it('serves windows-1252 text declared by an http-equiv Content-Type meta', async () => {
    const head = '<head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head>'
    const r = await serve(raw(head + CP1252_BODY), 'text/html')
    expect(r.json.content).toBe(head + CP1252_DECODED)
    expect(asText(r.inlineBytes)).toBe(head + CP1252_DECODED)
  })

  it('serves windows-1252 text declared only by the stored content type', async () => {
    const r = await serve(raw(CP1252_BODY), 'text/html; charset=windows-1252')
    expect(r.json.content).toBe(CP1252_DECODED)
    expect(asText(r.inlineBytes)).toBe(CP1252_DECODED)
  })

  it('decodes by an explicit declaration rather than assuming windows-1252', async () => {
    // Latin-2 byte 0xA1 is "A with ogonek"; windows-1252 would read an inverted bang.
    const r = await serve(raw('<meta charset="iso-8859-2"><p>\xA1</p>'), 'text/html')
    expect(r.json.content).toBe('<meta charset="iso-8859-2"><p>Ą</p>')
    expect(asText(r.inlineBytes)).toBe('<meta charset="iso-8859-2"><p>Ą</p>')
  })

  it('serves UTF-8 with multibyte characters unchanged', async () => {
    const html = '<p>“Sample Act” § 12–13 café 日本</p>'
    const r = await serve(utf8(html), 'text/html; charset=utf-8')
    expect(r.json.content).toBe(html)
    expect(asText(r.inlineBytes)).toBe(html)
    expect(r.inlineBytes).toEqual(utf8(html))
  })

  it('serves undeclared UTF-8 with multibyte characters unchanged', async () => {
    const html = '<p>“Sample Act” § café</p>'
    const r = await serve(utf8(html), 'text/html')
    expect(r.json.content).toBe(html)
    expect(asText(r.inlineBytes)).toBe(html)
  })

  it('keeps UTF-8 bytes as UTF-8 when the stored content type mislabels them iso-8859-1', async () => {
    const html = '<p>“Sample Act” § café</p>'
    const r = await serve(utf8(html), 'text/html; charset=iso-8859-1')
    expect(r.json.content).toBe(html)
    expect(asText(r.inlineBytes)).toBe(html)
  })

  it('serves ASCII-only documents unchanged', async () => {
    const html = '<html><body><p>Section 1. Nothing special.</p></body></html>'
    const r = await serve(utf8(html), 'text/html')
    expect(r.json.content).toBe(html)
    expect(asText(r.inlineBytes)).toBe(html)
  })

  it('falls back to windows-1252 when a document declares UTF-8 but is not', async () => {
    const meta = await serve(raw('<meta charset="utf-8">' + CP1252_BODY), 'text/html')
    expect(meta.json.content).toBe('<meta charset="utf-8">' + CP1252_DECODED)
    expect(asText(meta.inlineBytes)).toBe('<meta charset="utf-8">' + CP1252_DECODED)

    const header = await serve(raw(CP1252_BODY), 'text/html; charset=utf-8')
    expect(header.json.content).toBe(CP1252_DECODED)
    expect(asText(header.inlineBytes)).toBe(CP1252_DECODED)
  })

  it('serves an empty body as empty text', async () => {
    const r = await serve(new Uint8Array(0), 'text/html')
    expect(r.json).toEqual({ type: 'html', content: '', docId: expect.any(String), textHash: expect.any(String) })
    expect(r.inlineStatus).toBe(200)
    expect(r.inlineBytes.byteLength).toBe(0)
  })

  it('tells the panel the inline body is UTF-8, whatever the source charset was', async () => {
    const r = await serve(raw(CP1252_BODY), 'text/html; charset=windows-1252')
    expect(r.inlineType).toBe('text/html; charset=utf-8')
  })

  it('does not touch PDFs: bytes and content type pass through unchanged', async () => {
    // High bytes that are invalid UTF-8, as real PDF streams contain.
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x93, 0x94, 0xa7, 0x96, 0xff, 0xfe, 0x00])
    const r = await serve(pdf, 'application/pdf', 'pdf')
    expect(r.json.type).toBe('pdf')
    expect(Uint8Array.from(atob(r.json.content), ch => ch.charCodeAt(0))).toEqual(pdf)
    expect(r.inlineType).toBe('application/pdf')
    expect(r.inlineBytes).toEqual(pdf)
  })
})
