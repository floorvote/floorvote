import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { clearDb, appFetch, stubFetch, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentAttachments } from '../../src/db/schema'

// The feature is on only with the bucket bound and the S3 credentials that sign
// upload URLs. The test config binds the bucket; these add the rest.
const ON = () => ({
  ...env,
  ATTACHMENTS_BUCKET_NAME: 'fv-files',
  R2_ACCESS_KEY_ID: 'AK',
  R2_SECRET_ACCESS_KEY: 'SK',
})
const bucket = () => env.ATTACHMENTS_BUCKET!

const PDF = new TextEncoder().encode('%PDF-1.7\nhello pdf')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9])

type Started = { id: string; uploadUrl: string; uploadHeaders: Record<string, string>; expiresAt: string }

function json(token: string | null, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { ...(token ? { Cookie: `session=${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

function startUpload(token: string | null, name: string, size: number, bindings: object = ON()) {
  return appFetch('http://localhost/api/attachments', json(token, 'POST', { name, size }), bindings)
}

function keyOf(uploadUrl: string) {
  // /<bucket>/<key...>
  return new URL(uploadUrl).pathname.split('/').slice(2).map(decodeURIComponent).join('/')
}

// Stand in for the browser's PUT to the presigned URL, then confirm.
async function uploadFile(token: string, name: string, data: Uint8Array, opts: { declaredSize?: number } = {}) {
  const res = await startUpload(token, name, opts.declaredSize ?? data.length)
  expect(res.status).toBe(201)
  const started = await res.json() as Started
  await bucket().put(keyOf(started.uploadUrl), data)
  return started
}

function confirm(token: string, id: string, bindings: object = ON()) {
  return appFetch(`http://localhost/api/attachments/${id}/confirm`, json(token, 'POST'), bindings)
}

async function attached(token: string, name: string, data: Uint8Array) {
  const started = await uploadFile(token, name, data)
  const res = await confirm(token, started.id)
  expect(res.status).toBe(200)
  return started
}

function postComment(token: string, billId: string, attachmentIds: string[], bindings: object = ON()) {
  return appFetch(`http://localhost/api/bills/${billId}/comments`, json(token, 'POST', { content: '<p>See attached</p>', attachmentIds }), bindings)
}

function download(token: string | null, id: string, bindings: object = ON()) {
  return appFetch(`http://localhost/api/attachments/${id}`, { headers: token ? { Cookie: `session=${token}` } : {} }, bindings)
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

  describe('starting an upload', () => {
    it('returns a short-lived upload URL scoped to one key, size, and type', async () => {
      const res = await startUpload(member, 'Testimony.pdf', 1234)
      expect(res.status).toBe(201)
      const body = await res.json() as Started
      const url = new URL(body.uploadUrl)
      expect(url.host).toBe('test-account-id.r2.cloudflarestorage.com')
      expect(url.pathname).toMatch(/^\/fv-files\/bpc-test\/[0-9a-f-]{36}$/)
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(900)
      expect(body.uploadHeaders).toEqual({ 'Content-Type': 'application/pdf' })

      const again = await (await startUpload(member, 'Testimony.pdf', 1234)).json() as Started
      expect(keyOf(again.uploadUrl)).not.toBe(keyOf(body.uploadUrl))
    })

    it('refuses a blocked type with a clear message', async () => {
      const res = await startUpload(member, 'invite.html', 100)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toMatch(/"invite.html" can't be attached/)
    })

    it('refuses a file over 25 MB', async () => {
      const res = await startUpload(member, 'big.pdf', 25 * 1024 * 1024 + 1)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toMatch(/larger than 25 MB/)
    })

    it('refuses a caller without a session', async () => {
      expect((await startUpload(null, 'a.pdf', 10)).status).toBe(401)
    })

    it('is off when no bucket is bound', async () => {
      const res = await startUpload(member, 'a.pdf', 10, { ...ON(), ATTACHMENTS_BUCKET: undefined })
      expect(res.status).toBe(503)
      expect((await res.json() as { error: string }).error).toMatch(/not set up/)
    })

    it('is off when the upload credentials are missing', async () => {
      expect((await startUpload(member, 'a.pdf', 10, env)).status).toBe(503)
    })

    it('is refused on a demo instance', async () => {
      expect((await startUpload(member, 'a.pdf', 10, { ...ON(), DEMO_MODE: 'true' })).status).toBe(403)
    })

    it('limits how many uploads one member can start in an hour', async () => {
      for (let i = 0; i < 30; i++) expect((await startUpload(member, `f${i}.pdf`, 10)).status).toBe(201)
      expect((await startUpload(member, 'one-more.pdf', 10)).status).toBe(429)
      expect((await startUpload(other, 'theirs.pdf', 10)).status).toBe(201)
    })

    it('refuses an upload that would pass the instance quota', async () => {
      await getDb(env.DB).insert(commentAttachments).values({
        id: crypto.randomUUID(), uploaderId: memberId, r2Key: 'bpc-test/existing', name: 'x.pdf',
        contentType: 'application/pdf', size: 5 * 1024 ** 3 - 5, confirmedAt: '2026-10-01 00:00:00',
      })
      const res = await startUpload(other, 'a.pdf', 10)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toMatch(/storage/)
    })
  })

  describe('confirming an upload', () => {
    it('accepts a file whose bytes match its type', async () => {
      const started = await uploadFile(member, 'Testimony.pdf', PDF)
      const res = await confirm(member, started.id)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ id: started.id, name: 'Testimony.pdf', contentType: 'application/pdf', size: PDF.length })
    })

    it('refuses bytes that do not match the stated type, and deletes them', async () => {
      const started = await uploadFile(member, 'Testimony.pdf', PNG)
      const res = await confirm(member, started.id)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toMatch(/doesn't match its file type/)
      expect(await bucket().head(keyOf(started.uploadUrl))).toBeNull()
    })

    it('refuses an upload whose size differs from the one it was signed for', async () => {
      const started = await uploadFile(member, 'Testimony.pdf', PDF, { declaredSize: 5 })
      expect((await confirm(member, started.id)).status).toBe(400)
      expect(await bucket().head(keyOf(started.uploadUrl))).toBeNull()
    })

    it('refuses before the file has arrived', async () => {
      const res = await startUpload(member, 'a.pdf', 10)
      expect(res.status).toBe(201)
      const { id } = await res.json() as Started
      const c = await confirm(member, id)
      expect(c.status).toBe(400)
      expect((await c.json() as { error: string }).error).toMatch(/hasn't finished uploading/)
    })

    it("does not let another member confirm someone else's upload", async () => {
      const started = await uploadFile(member, 'a.pdf', PDF)
      expect((await confirm(other, started.id)).status).toBe(404)
    })
  })

  describe('posting with attachments', () => {
    it('attaches confirmed files to the comment and lists them with it', async () => {
      const a = await attached(member, 'Testimony.pdf', PDF)
      const b = await attached(member, 'Budget.docx', DOCX)
      const res = await postComment(member, billId, [a.id, b.id])
      expect(res.status).toBe(201)

      const list = await (await appFetch(`http://localhost/api/bills/${billId}/comments`, { headers: { Cookie: `session=${other}` } }, ON())).json() as { attachments: unknown[] }[]
      expect(list[0].attachments).toEqual([
        { id: a.id, name: 'Testimony.pdf', contentType: 'application/pdf', size: PDF.length },
        { id: b.id, name: 'Budget.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: DOCX.length },
      ])

      const detail = await (await appFetch(`http://localhost/api/bills/${billId}`, { headers: { Cookie: `session=${other}` } }, ON())).json() as { comments: { attachments: { id: string }[] }[] }
      expect(detail.comments[0].attachments.map(x => x.id)).toEqual([a.id, b.id])
    })

    it('refuses more than 10 files on one comment', async () => {
      const ids: string[] = []
      for (let i = 0; i < 11; i++) ids.push((await attached(member, `f${i}.pdf`, PDF)).id)
      const res = await postComment(member, billId, ids)
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toMatch(/10 files/)
    })

    it('refuses a file that was never confirmed', async () => {
      const started = await uploadFile(member, 'a.pdf', PDF)
      expect((await postComment(member, billId, [started.id])).status).toBe(400)
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
      expect((await download(other, pdfId, { ...ON(), TENANT_ID: 'another-instance' })).status).toBe(404)
    })

    it('refuses once the comment is deleted, and soft-deletes its files', async () => {
      const del = await appFetch(`http://localhost/api/comments/${commentId}`, json(member, 'DELETE'), ON())
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
      const started = await uploadFile(member, 'a.pdf', PDF)
      const res = await appFetch(`http://localhost/api/attachments/${started.id}`, json(member, 'DELETE'), ON())
      expect(res.status).toBe(204)
      expect(await bucket().head(keyOf(started.uploadUrl))).toBeNull()
    })

    it('does not remove a file that is on a posted comment', async () => {
      const a = await attached(member, 'a.pdf', PDF)
      await postComment(member, billId, [a.id])
      expect((await appFetch(`http://localhost/api/attachments/${a.id}`, json(member, 'DELETE'), ON())).status).toBe(404)
    })

    it("does not let another member remove someone's upload", async () => {
      const started = await uploadFile(member, 'a.pdf', PDF)
      expect((await appFetch(`http://localhost/api/attachments/${started.id}`, json(other, 'DELETE'), ON())).status).toBe(404)
    })
  })

  describe('usage', () => {
    it('shows admins the storage used against the quota', async () => {
      await attached(member, 'a.pdf', PDF)
      const res = await appFetch('http://localhost/api/attachments/usage', { headers: { Cookie: `session=${admin}` } }, ON())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: true, usedBytes: PDF.length, quotaBytes: 5 * 1024 ** 3 })
    })

    it('is not shown to members', async () => {
      expect((await appFetch('http://localhost/api/attachments/usage', { headers: { Cookie: `session=${member}` } }, ON())).status).toBe(403)
    })
  })

  describe('config', () => {
    it('tells the app the limits when attachments are on', async () => {
      const body = await (await appFetch('http://localhost/api/config', { headers: { Cookie: `session=${member}` } }, ON())).json() as { attachments: unknown }
      expect(body.attachments).toEqual({ maxBytes: 25 * 1024 * 1024, maxPerComment: 10 })
    })

    it('says attachments are off when no bucket is bound', async () => {
      const body = await (await appFetch('http://localhost/api/config', { headers: { Cookie: `session=${member}` } }, { ...ON(), ATTACHMENTS_BUCKET: undefined })).json() as { attachments: unknown }
      expect(body.attachments).toBeNull()
    })
  })
})
