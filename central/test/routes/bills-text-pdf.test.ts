import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

// GET /bills/:id/text/:docId is what the bill text panel's "Open in new tab" opens,
// in the app's own origin. A stored `.pdf` is served as a PDF only when its bytes are
// one: whatever content type was recorded on the object (a provider's error page is
// often recorded as HTML) never decides what the browser renders.

beforeEach(async () => {
  await setupLsDb()
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({
    sessionId: 1, state: 'VA', stateId: 46, yearStart: 2026, yearEnd: 2026, sessionName: 'VA 2026', sessionTitle: 'Regular',
  })
  await db.insert(schema.bills).values({
    billId: 300, sessionId: 1, state: 'VA', stateId: 46, billNumber: 'HB1', title: 'Bill 300', changeHash: 'h', status: 1,
  })
})

const headers = { 'x-admin-secret': 'test-secret' }

function makeCtx() {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p) },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return { ctx, settle: () => Promise.all(pending) }
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const PDF_HEAD = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
// A small PDF-shaped body with high bytes that are invalid UTF-8, as real streams contain.
const PDF = Uint8Array.from([...PDF_HEAD, 0x31, 0x2e, 0x37, 0x0a, 0x93, 0x94, 0xa7, 0x96, 0xff, 0xfe, 0x00])
const ERROR_PAGE = '<html><body><h1>503 Service Unavailable</h1><script>alert(1)</script></body></html>'

let nextDocId = 2000

async function store(bytes: Uint8Array, contentType: string | undefined, ext: 'html' | 'pdf' = 'pdf') {
  const docId = nextDocId++
  const r2Key = `bills/legiscan-300/texts/${docId}.${ext}`
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.billTexts).values({
    docId, billId: 300, date: '2026-03-01', type: 'Text', textHash: `hash-${docId}`, r2Key,
    mime: ext === 'pdf' ? 'application/pdf' : 'text/html',
  })
  await env.BILLS_BUCKET.put(r2Key, bytes, contentType ? { httpMetadata: { contentType } } : undefined)
  return { docId, r2Key }
}

async function inline(docId: number, ctx: ExecutionContext = makeCtx().ctx) {
  return app.request(`/api/bills/300/text/${docId}`, { headers }, env, ctx)
}

async function json(ctx: ExecutionContext = makeCtx().ctx) {
  return app.request('/api/bills/300/text', { headers }, env, ctx)
}

async function serve(bytes: Uint8Array, contentType: string | undefined, ext: 'html' | 'pdf' = 'pdf') {
  const { docId } = await store(bytes, contentType, ext)
  const res = await inline(docId)
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) }
}

describe('stored PDFs are served as PDFs, whatever type was recorded', () => {
  it('serves a valid PDF inline as application/pdf, nosniff, bytes unchanged', async () => {
    const { res, bytes } = await serve(PDF, 'application/pdf')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(bytes).toEqual(PDF)
  })

  it('serves a PDF recorded with an HTML content type as application/pdf', async () => {
    const { res, bytes } = await serve(PDF, 'text/html; charset=utf-8')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(bytes).toEqual(PDF)
  })

  it('serves a PDF recorded as application/octet-stream as application/pdf', async () => {
    const { res, bytes } = await serve(PDF, 'application/octet-stream')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(bytes).toEqual(PDF)
  })

  it('serves a PDF with no recorded content type as application/pdf', async () => {
    const { res } = await serve(PDF, undefined)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves a PDF recorded with a parameterized or odd-cased PDF type as plain application/pdf', async () => {
    const { res } = await serve(PDF, 'Application/PDF; charset=binary')
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('serves a PDF recorded with a script-capable type (svg, xml, javascript) as application/pdf', async () => {
    for (const type of ['image/svg+xml', 'application/xhtml+xml', 'text/javascript', 'text/xml']) {
      const { res } = await serve(PDF, type)
      expect(res.headers.get('content-type'), type).toBe('application/pdf')
    }
  })

  it('serves a multi-megabyte PDF byte for byte', async () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 7)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
    big.set(PDF_HEAD, 0)
    const { res, bytes } = await serve(big, 'text/html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(bytes.byteLength).toBe(big.byteLength)
    // Buffer.equals, not toEqual: comparing two 3 MB arrays with toEqual took ~10 s, close to the 20 s timeout under load.
    expect(Buffer.from(bytes).equals(Buffer.from(big))).toBe(true)
  })

  it('serves a PDF that is exactly the five magic bytes', async () => {
    const { res, bytes } = await serve(Uint8Array.from(PDF_HEAD), 'text/html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(bytes).toEqual(Uint8Array.from(PDF_HEAD))
  })
})

const NOT_A_PDF: Array<[string, Uint8Array, string | undefined]> = [
  ['an HTML error page recorded as HTML', utf8(ERROR_PAGE), 'text/html'],
  ['an HTML error page recorded as application/pdf', utf8(ERROR_PAGE), 'application/pdf'],
  ['an HTML error page recorded as octet-stream', utf8(ERROR_PAGE), 'application/octet-stream'],
  ['an HTML error page with no recorded type', utf8(ERROR_PAGE), undefined],
  ['SVG with script', utf8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'],
  ['plain text', utf8('Not Found'), 'text/plain'],
  ['an empty body', new Uint8Array(0), 'application/pdf'],
  ['a truncated magic (%PDF)', utf8('%PDF'), 'application/pdf'],
  ['the magic without its dash (%PDF1.7)', utf8('%PDF1.7\n'), 'application/pdf'],
  ['a lowercase magic (%pdf-)', utf8('%pdf-1.7\n'), 'application/pdf'],
  ['whitespace before the magic', utf8(' %PDF-1.7\n'), 'application/pdf'],
  ['a BOM before the magic', Uint8Array.from([0xef, 0xbb, 0xbf, ...PDF_HEAD]), 'application/pdf'],
  ['HTML that merely mentions %PDF- later on', utf8('<p>%PDF-1.7</p>'), 'text/html'],
]

describe('stored bytes that are not a PDF are never served as a PDF or rendered inline', () => {
  for (const [label, bytes, type] of NOT_A_PDF) {
    it(`refuses ${label}: a clear error, not inline, not a PDF`, async () => {
      const { res, bytes: body } = await serve(bytes, type)
      expect(res.status).toBe(502)
      const contentType = res.headers.get('content-type') ?? ''
      expect(contentType).toContain('application/json')
      expect(contentType).not.toContain('pdf')
      expect(contentType).not.toContain('html')
      expect(res.headers.get('content-disposition') ?? '').not.toContain('inline')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      const text = new TextDecoder().decode(body)
      expect(JSON.parse(text)).toEqual({ error: 'stored document is not a valid PDF' })
      // None of the stored bytes leak into the response.
      expect(text).not.toContain('<script')
      expect(text).not.toContain('503 Service')
    })
  }

  it('detects by bytes, not by name: a .html object holding PDF bytes is never labeled application/pdf from its recorded type alone', async () => {
    // The key says HTML; the route keeps decoding it as HTML and never trusts a recorded PDF type.
    const { res } = await serve(utf8('<p>hello</p>'), 'application/pdf', 'html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })
})

describe('stored HTML is unaffected', () => {
  it('still serves HTML as UTF-8 text/html, inline', async () => {
    const html = '<p>“Sample Act” § café</p>'
    const { res, bytes } = await serve(utf8(html), 'text/html; charset=utf-8', 'html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(new TextDecoder().decode(bytes)).toBe(html)
  })

  it('sends nosniff with HTML too', async () => {
    const { res } = await serve(utf8('<p>hi</p>'), 'text/html', 'html')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('does not require HTML to look like a PDF or anything else', async () => {
    const { res, bytes } = await serve(new Uint8Array(0), 'text/html', 'html')
    expect(res.status).toBe(200)
    expect(bytes.byteLength).toBe(0)
  })
})

describe('missing documents', () => {
  it('404s a doc id the bill does not have', async () => {
    const res = await inline(999999)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'no text available' })
  })

  it('404s a stored row whose R2 object is gone', async () => {
    const { docId, r2Key } = await store(PDF, 'application/pdf')
    await env.BILLS_BUCKET.delete(r2Key)
    const res = await inline(docId)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'text not found in storage' })
  })

  it('400s a non-numeric doc id', async () => {
    const res = await app.request('/api/bills/300/text/abc', { headers }, env, makeCtx().ctx)
    expect(res.status).toBe(400)
  })
})

describe('the response cache', () => {
  it('serves a cached PDF with the same type, disposition, and nosniff', async () => {
    const { docId, r2Key } = await store(PDF, 'text/html')
    const first = makeCtx()
    const a = await inline(docId, first.ctx)
    expect(a.status).toBe(200)
    await a.arrayBuffer()
    await first.settle()

    await env.BILLS_BUCKET.delete(r2Key) // only a cache hit can answer now
    const b = await inline(docId)
    expect(b.status).toBe(200)
    expect(b.headers.get('content-type')).toBe('application/pdf')
    expect(b.headers.get('content-disposition')).toBe('inline')
    expect(b.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await b.arrayBuffer())).toEqual(PDF)
  })

  it('does not cache a refusal: the document is served once its bytes are replaced', async () => {
    const { docId, r2Key } = await store(utf8(ERROR_PAGE), 'text/html')
    const first = makeCtx()
    const a = await inline(docId, first.ctx)
    expect(a.status).toBe(502)
    await a.arrayBuffer()
    await first.settle()

    await env.BILLS_BUCKET.put(r2Key, PDF, { httpMetadata: { contentType: 'application/pdf' } })
    // Drain the body and settle the cache write, so no stream is left pulling from R2
    // when the next test's storage is torn down.
    const second = makeCtx()
    const b = await inline(docId, second.ctx)
    expect(b.status).toBe(200)
    expect(b.headers.get('content-type')).toBe('application/pdf')
    await b.arrayBuffer()
    await second.settle()
  })
})

// GET /bills/:id/text is the JSON route the analysis path reads. It returns a stored
// `.pdf` base64-encoded, so a client that decodes it as a PDF would take a provider's
// error page for one. It makes the same byte check as the inline route above.
describe('the JSON text route byte-checks stored PDFs', () => {
  const stored = () => store(PDF, 'application/pdf')

  it('returns a valid PDF as base64 with the doc id and hash, as before', async () => {
    const { docId } = await stored()
    const res = await json()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as { type: string; content: string; docId: string; textHash: string }
    expect(body).toMatchObject({ type: 'pdf', docId: String(docId), textHash: `hash-${docId}` })
    expect(Uint8Array.from(Buffer.from(body.content, 'base64'))).toEqual(PDF)
  })

  it('returns a valid PDF whatever content type it was stored with', async () => {
    for (const type of ['text/html', 'application/octet-stream', undefined]) {
      await store(PDF, type)
      const res = await json()
      expect(res.status, String(type)).toBe(200)
      expect((await res.json() as { type: string }).type).toBe('pdf')
    }
  })

  it('returns a multi-megabyte PDF byte for byte', async () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 7)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
    big.set(PDF_HEAD, 0)
    await store(big, 'application/pdf')
    const res = await json()
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string }
    // Buffer.equals, not toEqual: a 3 MB array comparison is slow enough to time out under load.
    expect(Buffer.from(body.content, 'base64').equals(Buffer.from(big))).toBe(true)
  })

  it('returns a PDF that is exactly the five magic bytes', async () => {
    await store(Uint8Array.from(PDF_HEAD), 'application/pdf')
    const res = await json()
    expect(res.status).toBe(200)
    const body = await res.json() as { type: string; content: string }
    expect(body.type).toBe('pdf')
    expect(Uint8Array.from(Buffer.from(body.content, 'base64'))).toEqual(Uint8Array.from(PDF_HEAD))
  })

  for (const [label, bytes, type] of NOT_A_PDF) {
    it(`refuses ${label}: a clear error, no base64, no stored bytes`, async () => {
      await store(bytes, type)
      const res = await json()
      expect(res.status).toBe(502)
      expect(res.headers.get('content-type') ?? '').toContain('application/json')
      const text = await res.text()
      expect(JSON.parse(text)).toEqual({ error: 'stored document is not a valid PDF' })
      expect(text).not.toContain('content')
      expect(text).not.toContain(Buffer.from(bytes).toString('base64').slice(0, 12) || 'impossible-empty')
    })
  }

  it('does not cache a refusal: the document is served once its bytes are replaced', async () => {
    const { r2Key } = await store(utf8(ERROR_PAGE), 'text/html')
    const first = makeCtx()
    const a = await json(first.ctx)
    expect(a.status).toBe(502)
    await a.arrayBuffer()
    await first.settle()

    await env.BILLS_BUCKET.put(r2Key, PDF, { httpMetadata: { contentType: 'application/pdf' } })
    const b = await json()
    expect(b.status).toBe(200)
    expect((await b.json() as { type: string }).type).toBe('pdf')
  })

  it('serves a cached valid PDF without reading storage again', async () => {
    const { r2Key } = await stored()
    const first = makeCtx()
    const a = await json(first.ctx)
    expect(a.status).toBe(200)
    await a.arrayBuffer()
    await first.settle()

    await env.BILLS_BUCKET.delete(r2Key) // only a cache hit can answer now
    const b = await json()
    expect(b.status).toBe(200)
    expect((await b.json() as { type: string }).type).toBe('pdf')
  })

  it('checks the newest text, not an older one', async () => {
    await store(PDF, 'application/pdf') // older doc id: valid
    await store(utf8(ERROR_PAGE), 'text/html') // newest: not a PDF
    expect((await json()).status).toBe(502)
  })

  it('leaves stored HTML alone, even when it starts like nothing in particular', async () => {
    await store(utf8('<p>“Sample Act” § café</p>'), 'text/html; charset=utf-8', 'html')
    const res = await json()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ type: 'html', content: '<p>“Sample Act” § café</p>' })
  })

  it('leaves an empty stored HTML body alone', async () => {
    await store(new Uint8Array(0), 'text/html', 'html')
    const res = await json()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ type: 'html', content: '' })
  })

  it('still 404s a bill with no stored text and a row whose object is gone', async () => {
    expect((await json()).status).toBe(404)
    const { r2Key } = await stored()
    await env.BILLS_BUCKET.delete(r2Key)
    const res = await json()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'text not found in storage' })
  })
})
