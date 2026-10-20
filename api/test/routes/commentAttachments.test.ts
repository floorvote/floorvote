import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, isNull } from 'drizzle-orm'
import { clearDb, appFetch, stubFetch, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentAttachments, feedEvents } from '../../src/db/schema'
import { purgeAttachments, uploadAttachment, UPLOAD_DEADLINE_MS } from '../../src/lib/attachments'

// The test config binds ATTACHMENTS_BUCKET, which is all the feature needs.
const OFF = () => ({ ...env, ATTACHMENTS_BUCKET: undefined })
const bucket = () => env.ATTACHMENTS_BUCKET!

const PDF = new TextEncoder().encode('%PDF-1.7\nhello pdf')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9])

type Uploaded = { id: string; name: string; contentType: string; size: number }

function json(token: string | null, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { ...(token ? { Cookie: `session=${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

// The body in chunks, as a browser's upload arrives.
function chunked(data: Uint8Array, size = 1000): ReadableStream<Uint8Array> {
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= data.length) return controller.close()
      controller.enqueue(data.slice(at, at + size))
      at += size
    },
  })
}

function upload(
  token: string | null, name: string, data: Uint8Array,
  opts: { bindings?: object; contentLength?: number } = {},
) {
  return appFetch(`http://localhost/api/attachments?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      ...(token ? { Cookie: `session=${token}` } : {}),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(opts.contentLength ?? data.length),
    },
    body: chunked(data),
  }, opts.bindings ?? env)
}

async function storedCount() {
  return (await bucket().list({ prefix: 'bpc-test/' })).objects.length
}

async function attached(token: string, name: string, data: Uint8Array): Promise<Uploaded> {
  const res = await upload(token, name, data)
  expect(res.status).toBe(201)
  return res.json() as Promise<Uploaded>
}

function postComment(token: string, billId: string, attachmentIds: string[], bindings: object = env) {
  return appFetch(`http://localhost/api/bills/${billId}/comments`, json(token, 'POST', { content: '<p>See attached</p>', attachmentIds }), bindings)
}

function download(token: string | null, id: string, bindings: object = env) {
  return appFetch(`http://localhost/api/attachments/${id}`, { headers: token ? { Cookie: `session=${token}` } : {} }, bindings)
}

async function errorOf(res: Response) {
  return (await res.json() as { error: string }).error
}

describe('comment attachments', () => {
  let memberId: string
  let member: string
  let other: string
  let admin: string
  let billId: string

  beforeEach(async () => {
    stubFetch()
    await clearDb()
    memberId = await seedUser()
    member = await seedSession(memberId)
    other = await seedSession(await seedUser())
    admin = await seedSession(await seedUser({ role: 'admin' }))
    billId = await seedBill()
  })

  describe('a comment with only files', () => {
    const blank = (token: string, attachmentIds?: unknown, content = '') =>
      appFetch(`http://localhost/api/bills/${billId}/comments`, json(token, 'POST', { content, attachmentIds }), env)

    it('posts with no text, and the feed preview names the file', async () => {
      const { id } = await attached(member, 'Report.pdf', PDF)
      const res = await blank(member, [id])
      expect(res.status).toBe(201)
      const body = await res.json() as { content: string; attachments: Uploaded[] }
      expect(body.content).toBe('')
      expect(body.attachments.map(a => a.id)).toEqual([id])
      const event = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.type, 'comment_added')).get()
      expect(JSON.parse(event!.metadata!).preview).toBe('Attached Report.pdf')
    })

    it('says how many files when there are several', async () => {
      const a = await attached(member, 'A.pdf', PDF)
      const b = await attached(member, 'B.png', PNG)
      expect((await blank(member, [a.id, b.id], '<p></p>')).status).toBe(201)
      const event = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.type, 'comment_added')).get()
      expect(JSON.parse(event!.metadata!).preview).toBe('Attached 2 files')
    })

    it('still refuses a blank comment with no files', async () => {
      expect((await blank(member)).status).toBe(400)
      expect((await blank(member, [])).status).toBe(400)
    })

    it('refuses a blank comment whose file is not attachable', async () => {
      const theirs = await attached(other, 'Theirs.pdf', PDF)
      expect((await blank(member, [theirs.id])).status).toBe(400)
      expect((await blank(member, ['no-such-upload'])).status).toBe(400)
      expect(await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.type, 'comment_added')).all()).toHaveLength(0)
    })
  })

  describe('uploading', () => {
    it('streams the file into the bucket and returns it', async () => {
      const res = await upload(member, 'Testimony.pdf', PDF)
      expect(res.status).toBe(201)
      const body = await res.json() as Uploaded
      expect(body).toMatchObject({ name: 'Testimony.pdf', contentType: 'application/pdf', size: PDF.length })
      const row = await getDb(env.DB).select().from(commentAttachments).where(eq(commentAttachments.id, body.id)).get()
      expect(row!.r2Key).toMatch(/^bpc-test\/[0-9a-f-]{36}$/)
      const object = await bucket().get(row!.r2Key)
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PDF)
      expect(object!.httpMetadata?.contentType).toBe('application/pdf')
    })

    it('keeps every byte of a file larger than the sniffed head', async () => {
      const big = new Uint8Array(100_000)
      big.set(PDF)
      for (let i = PDF.length; i < big.length; i++) big[i] = i % 251
      const { id } = await attached(member, 'Long.pdf', big)
      await postComment(member, billId, [id])
      expect(new Uint8Array(await (await download(other, id)).arrayBuffer())).toEqual(big)
    })

    // The first 4 KB are read ahead and checked, then written before the rest.
    it.each([100, 4095, 4096, 4097, 9000])('stores a %i-byte file byte for byte across the sniffed head', async (n) => {
      const data = new Uint8Array(n)
      data.set(PDF)
      for (let i = PDF.length; i < n; i++) data[i] = (i * 7) % 256
      const res = await appFetch(`http://localhost/api/attachments?name=f.pdf`, {
        method: 'POST',
        headers: { Cookie: `session=${member}`, 'Content-Length': String(n) },
        body: chunked(data, 1024),
      })
      expect(res.status).toBe(201)
      const { id } = await res.json() as Uploaded
      const row = await getDb(env.DB).select().from(commentAttachments).where(eq(commentAttachments.id, id)).get()
      expect(new Uint8Array(await (await bucket().get(row!.r2Key))!.arrayBuffer())).toEqual(data)
    })

    it('refuses a body that runs past its declared length after the head, and keeps none of it', async () => {
      const data = new Uint8Array(20_000)
      data.set(PDF)
      const before = await storedCount()
      const res = await upload(member, 'Testimony.pdf', data, { contentLength: 10_000 })
      expect(res.status).toBe(400)
      expect(await storedCount()).toBe(before)
      const live = await getDb(env.DB).select().from(commentAttachments).where(isNull(commentAttachments.deletedAt)).all()
      expect(live).toEqual([])
    })

    it('refuses a blocked type without storing anything', async () => {
      const before = await storedCount()
      const res = await upload(member, 'invite.html', new TextEncoder().encode('hello'))
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toMatch(/"invite.html" can't be attached/)
      expect(await storedCount()).toBe(before)
    })

    it('refuses a file over 25 MB from its declared length, before reading it', async () => {
      const res = await upload(member, 'big.pdf', PDF, { contentLength: 25 * 1024 * 1024 + 1 })
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toMatch(/larger than 25 MB/)
    })

    it('refuses bytes that do not match the stated type without storing them', async () => {
      const before = await storedCount()
      const res = await upload(member, 'Testimony.pdf', PNG)
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toMatch(/doesn't match its file type/)
      expect(await storedCount()).toBe(before)
    })

    it('refuses a body longer than its declared length, and keeps none of it', async () => {
      const before = await storedCount()
      const res = await upload(member, 'Testimony.pdf', PDF, { contentLength: 10 })
      expect(res.status).toBe(400)
      expect(await storedCount()).toBe(before)
    })

    it('refuses a body shorter than its declared length, and keeps none of it', async () => {
      const big = new Uint8Array(20_000)
      big.set(PDF)
      const before = await storedCount()
      const res = await upload(member, 'Testimony.pdf', big, { contentLength: 30_000 })
      expect(res.status).toBe(400)
      expect(await storedCount()).toBe(before)
      const live = await getDb(env.DB).select().from(commentAttachments).where(isNull(commentAttachments.deletedAt)).all()
      expect(live).toEqual([])
    })

    it('refuses a caller without a session', async () => {
      expect((await upload(null, 'a.pdf', PDF)).status).toBe(401)
    })

    it('is off when no bucket is bound', async () => {
      const res = await upload(member, 'a.pdf', PDF, { bindings: OFF() })
      expect(res.status).toBe(503)
      expect(await errorOf(res)).toMatch(/not set up/)
    })

    it('is refused on a demo instance', async () => {
      expect((await upload(member, 'a.pdf', PDF, { bindings: { ...env, DEMO_MODE: 'true' } })).status).toBe(403)
    })

    it('limits how many uploads one member can make in an hour', async () => {
      for (let i = 0; i < 30; i++) expect((await upload(member, `f${i}.pdf`, PDF)).status).toBe(201)
      expect((await upload(member, 'one-more.pdf', PDF)).status).toBe(429)
      expect((await upload(other, 'theirs.pdf', PDF)).status).toBe(201)
    })

    it('holds the hourly limit when uploads arrive at once', async () => {
      const results = await Promise.all(Array.from({ length: 36 }, (_, i) => upload(member, `p${i}.pdf`, PDF)))
      expect(results.filter(r => r.status === 201)).toHaveLength(30)
    })

    it('stops counting an upload that never finished toward the quota after an hour', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      await getDb(env.DB).insert(commentAttachments).values([
        {
          id: crypto.randomUUID(), uploaderId: memberId, r2Key: 'bpc-test/nearly-full', name: 'x.pdf',
          contentType: 'application/pdf', size: 5 * 1024 ** 3 - 25 * 1024 * 1024, confirmedAt: '2026-10-01 00:00:00',
        },
        {
          id: crypto.randomUUID(), uploaderId: memberId, r2Key: 'bpc-test/abandoned', name: 'y.pdf',
          contentType: 'application/pdf', size: 25 * 1024 * 1024, createdAt: twoHoursAgo,
        },
      ])
      expect((await upload(other, 'a.pdf', PDF)).status).toBe(201)
    })

    it('refuses an upload that would pass the instance quota', async () => {
      await getDb(env.DB).insert(commentAttachments).values({
        id: crypto.randomUUID(), uploaderId: memberId, r2Key: 'bpc-test/existing', name: 'x.pdf',
        contentType: 'application/pdf', size: 5 * 1024 ** 3 - 5, confirmedAt: '2026-10-01 00:00:00',
      })
      const res = await upload(other, 'a.pdf', PDF)
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toMatch(/storage/)
    })
  })

  describe('an upload that stalls', () => {
    // A PDF body that sends its first 5,000 bytes, then waits until the test
    // releases the rest.
    function stalling(total: number) {
      const data = new Uint8Array(total)
      data.set(PDF)
      let release!: () => void
      const gate = new Promise<void>(r => { release = r })
      let sent = false
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) { sent = true; controller.enqueue(data.slice(0, 5000)); return }
          await gate
          controller.enqueue(data.slice(5000))
          controller.close()
        },
      })
      return { stream, release }
    }

    async function waitForRow() {
      for (let i = 0; i < 200; i++) {
        const row = await getDb(env.DB).select().from(commentAttachments).get()
        if (row) return row
        await new Promise(r => setTimeout(r, 10))
      }
      throw new Error('the upload never wrote its row')
    }

    it('is refused, leaving nothing behind, when the purge takes its row mid-upload', async () => {
      const { stream, release } = stalling(10_000)
      const pending = appFetch('http://localhost/api/attachments?name=slow.pdf', {
        method: 'POST',
        headers: { Cookie: `session=${member}`, 'Content-Length': '10000' },
        body: stream,
      })
      const row = await waitForRow()
      await purgeAttachments(env, getDb(env.DB), new Date(Date.now() + 2 * 60 * 60 * 1000))
      release()

      const res = await pending
      expect(res.status).toBe(400)
      expect(await bucket().head(row.r2Key)).toBeNull()
      expect(await getDb(env.DB).select().from(commentAttachments).all()).toEqual([])
    })

    it('is refused at its deadline, keeping nothing and no live row', async () => {
      const { stream } = stalling(10_000)
      const before = await storedCount()
      const r = await uploadAttachment(env, getDb(env.DB), memberId, { name: 'slow.pdf', contentLength: '10000', body: stream }, new Date(), { deadlineMs: 50 })
      expect(r).toMatchObject({ ok: false, status: 400 })
      expect(await storedCount()).toBe(before)
      expect(await getDb(env.DB).select().from(commentAttachments).where(isNull(commentAttachments.deletedAt)).all()).toEqual([])
    })

    it('is refused at its deadline while still sending its first bytes', async () => {
      const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
      const r = await uploadAttachment(env, getDb(env.DB), memberId, { name: 'slow.pdf', contentLength: '10000', body: stream }, new Date(), { deadlineMs: 50 })
      expect(r).toMatchObject({ ok: false, status: 400 })
    })

    it('gives an upload 15 minutes', () => {
      expect(UPLOAD_DEADLINE_MS).toBe(15 * 60 * 1000)
    })
  })

  describe('posting with attachments', () => {
    it('attaches uploaded files to the comment and lists them with it', async () => {
      const a = await attached(member, 'Testimony.pdf', PDF)
      const b = await attached(member, 'Budget.docx', DOCX)
      const res = await postComment(member, billId, [a.id, b.id])
      expect(res.status).toBe(201)
      expect((await res.json() as { attachments: { id: string }[] }).attachments.map(x => x.id)).toEqual([a.id, b.id])

      const list = await (await appFetch(`http://localhost/api/bills/${billId}/comments`, { headers: { Cookie: `session=${other}` } })).json() as { attachments: unknown[] }[]
      expect(list[0].attachments).toEqual([
        { id: a.id, name: 'Testimony.pdf', contentType: 'application/pdf', size: PDF.length },
        { id: b.id, name: 'Budget.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: DOCX.length },
      ])

      const detail = await (await appFetch(`http://localhost/api/bills/${billId}`, { headers: { Cookie: `session=${other}` } })).json() as { comments: { attachments: { id: string }[] }[] }
      expect(detail.comments[0].attachments.map(x => x.id)).toEqual([a.id, b.id])
    })

    it('refuses more than 10 files on one comment', async () => {
      const ids: string[] = []
      for (let i = 0; i < 11; i++) ids.push((await attached(member, `f${i}.pdf`, PDF)).id)
      const res = await postComment(member, billId, ids)
      expect(res.status).toBe(400)
      expect(await errorOf(res)).toMatch(/10 files/)
    })

    it("refuses another member's file", async () => {
      const a = await attached(member, 'a.pdf', PDF)
      expect((await postComment(other, billId, [a.id])).status).toBe(400)
    })

    it('refuses a file already on another comment', async () => {
      const a = await attached(member, 'a.pdf', PDF)
      expect((await postComment(member, billId, [a.id])).status).toBe(201)
      expect((await postComment(member, billId, [a.id])).status).toBe(400)
    })
  })

  describe('downloading', () => {
    let pdfId: string
    let docxId: string
    let commentId: string

    beforeEach(async () => {
      pdfId = (await attached(member, 'Testimony.pdf', PDF)).id
      docxId = (await attached(member, 'Budget "final".docx', DOCX)).id
      commentId = (await (await postComment(member, billId, [pdfId, docxId])).json() as { id: string }).id
    })

    it('serves a document as a download with nosniff and a sandbox CSP', async () => {
      const res = await download(other, docxId)
      expect(res.status).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(DOCX)
      expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="Budget _final_.docx"; filename\*=UTF-8''Budget%20%22final%22.docx$/)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Content-Security-Policy')).toMatch(/^sandbox; default-src 'none'/)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store')
      expect(res.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    })

    it('lets a PDF open in the browser', async () => {
      const res = await download(other, pdfId)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Disposition')).toMatch(/^inline; /)
      expect(res.headers.get('Content-Security-Policy')).toMatch(/^sandbox/)
    })

    it('refuses a caller without a session', async () => {
      expect((await download(null, pdfId)).status).toBe(401)
    })

    it("refuses a file from another instance's storage", async () => {
      expect((await download(other, pdfId, { ...env, TENANT_ID: 'another-instance' })).status).toBe(404)
    })

    it('refuses once the comment is deleted, and soft-deletes its files', async () => {
      const del = await appFetch(`http://localhost/api/comments/${commentId}`, json(member, 'DELETE'))
      expect(del.status).toBe(204)
      expect((await download(other, pdfId)).status).toBe(404)
      const rows = await getDb(env.DB).select().from(commentAttachments).where(eq(commentAttachments.commentId, commentId)).all()
      expect(rows.every(r => r.deletedAt !== null)).toBe(true)
    })

    it('refuses a file not on a posted comment', async () => {
      const loose = await attached(member, 'loose.pdf', PDF)
      expect((await download(member, loose.id)).status).toBe(404)
    })
  })

  describe('removing a file before posting', () => {
    it('lets the uploader remove an unattached file, deleting it from storage', async () => {
      const a = await attached(member, 'a.pdf', PDF)
      const before = await storedCount()
      const res = await appFetch(`http://localhost/api/attachments/${a.id}`, json(member, 'DELETE'))
      expect(res.status).toBe(204)
      expect(await storedCount()).toBe(before - 1)
    })

    it('does not remove a file that is on a posted comment', async () => {
      const a = await attached(member, 'a.pdf', PDF)
      await postComment(member, billId, [a.id])
      expect((await appFetch(`http://localhost/api/attachments/${a.id}`, json(member, 'DELETE'))).status).toBe(404)
    })

    it("does not let another member remove someone's upload", async () => {
      const a = await attached(member, 'a.pdf', PDF)
      expect((await appFetch(`http://localhost/api/attachments/${a.id}`, json(other, 'DELETE'))).status).toBe(404)
    })
  })

  describe('usage', () => {
    it('shows admins the storage used against the quota', async () => {
      await attached(member, 'a.pdf', PDF)
      const res = await appFetch('http://localhost/api/attachments/usage', { headers: { Cookie: `session=${admin}` } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: true, usedBytes: PDF.length, quotaBytes: 5 * 1024 ** 3 })
    })

    it("does not count a file whose comment no longer exists", async () => {
      const a = await attached(member, 'a.pdf', PDF)
      const { id: commentId } = await (await postComment(member, billId, [a.id])).json() as { id: string }
      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run()
      const res = await appFetch('http://localhost/api/attachments/usage', { headers: { Cookie: `session=${admin}` } })
      expect((await res.json() as { usedBytes: number }).usedBytes).toBe(0)
    })

    it('is not shown to members', async () => {
      expect((await appFetch('http://localhost/api/attachments/usage', { headers: { Cookie: `session=${member}` } })).status).toBe(403)
    })
  })

  describe('config', () => {
    it('tells the app the limits when attachments are on', async () => {
      const body = await (await appFetch('http://localhost/api/config', { headers: { Cookie: `session=${member}` } })).json() as { attachments: unknown }
      expect(body.attachments).toEqual({ maxBytes: 25 * 1024 * 1024, maxPerComment: 10 })
    })

    it('says attachments are off when no bucket is bound', async () => {
      const body = await (await appFetch('http://localhost/api/config', { headers: { Cookie: `session=${member}` } }, OFF())).json() as { attachments: unknown }
      expect(body.attachments).toBeNull()
    })
  })
})
