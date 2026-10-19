import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedUser, seedBill, seedComment } from '../helpers'
import { getDb } from '../../src/db/client'
import { commentAttachments } from '../../src/db/schema'
import { purgeAttachments } from '../../src/lib/attachments'

const NOW = new Date('2026-10-19T12:00:00Z')

describe('purgeAttachments', () => {
  let userId: string
  let commentId: string

  beforeEach(async () => {
    await clearDb()
    userId = await seedUser()
    commentId = await seedComment(await seedBill(), userId)
  })

  async function seed(name: string, fields: { commentId?: string | null; createdAt: string; deletedAt?: string | null }) {
    const key = `bpc-test/${crypto.randomUUID()}`
    await env.ATTACHMENTS_BUCKET!.put(key, 'x')
    await getDb(env.DB).insert(commentAttachments).values({
      id: crypto.randomUUID(), uploaderId: userId, r2Key: key, name, contentType: 'application/pdf', size: 1,
      commentId: fields.commentId ?? null, createdAt: fields.createdAt, deletedAt: fields.deletedAt ?? null,
    })
    return key
  }

  async function names() {
    return (await getDb(env.DB).select({ name: commentAttachments.name }).from(commentAttachments).all()).map(r => r.name).sort()
  }

  it('removes uploads never attached to a posted comment after a day', async () => {
    const old = await seed('old-loose', { createdAt: '2026-10-18 11:00:00' })
    const fresh = await seed('fresh-loose', { createdAt: '2026-10-19 02:00:00' })
    await seed('posted', { commentId, createdAt: '2026-09-01 00:00:00' })

    await purgeAttachments(env, getDb(env.DB), NOW)

    expect(await names()).toEqual(['fresh-loose', 'posted'])
    expect(await env.ATTACHMENTS_BUCKET!.head(old)).toBeNull()
    expect(await env.ATTACHMENTS_BUCKET!.head(fresh)).not.toBeNull()
  })

  it("purges a deleted comment's files 30 days after the delete", async () => {
    const gone = await seed('deleted-long-ago', { commentId, createdAt: '2026-08-01 00:00:00', deletedAt: '2026-09-18 11:00:00' })
    await seed('deleted-recently', { commentId, createdAt: '2026-08-01 00:00:00', deletedAt: '2026-10-01 00:00:00' })

    await purgeAttachments(env, getDb(env.DB), NOW)

    expect(await names()).toEqual(['deleted-recently'])
    expect(await env.ATTACHMENTS_BUCKET!.head(gone)).toBeNull()
  })

  it('purges at once the files of a comment that no longer exists', async () => {
    const orphan = await seed('orphan', { commentId, createdAt: '2026-10-19 11:00:00' })
    await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run()

    await purgeAttachments(env, getDb(env.DB), NOW)

    expect(await names()).toEqual([])
    expect(await env.ATTACHMENTS_BUCKET!.head(orphan)).toBeNull()
  })

  it('leaves the rows alone until a bucket is bound to delete the bytes from', async () => {
    await seed('old-loose', { createdAt: '2026-10-01 00:00:00' })
    await purgeAttachments({ ...env, ATTACHMENTS_BUCKET: undefined }, getDb(env.DB), NOW)
    expect(await names()).toEqual(['old-loose'])
    await purgeAttachments(env, getDb(env.DB), NOW)
    expect(await names()).toEqual([])
  })
})
