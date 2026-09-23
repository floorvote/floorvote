/**
 * GET /notifications — billIsDraft
 *
 * The mention panel's bill footer reads billIsDraft to pick the dashed
 * BillBadge variant, but its component test builds the mention rows by hand —
 * so a dropped select column or a typo in the emit would ship solid navy badges
 * for drafts in the notifications panel with a green web suite. That is the bug
 * the dashed variant exists to fix, returning silently. These assert the wire
 * payload itself.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import {
  resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment, seedCommentMention,
} from '../helpers'

describe('GET /notifications — billIsDraft', () => {
  let recipientToken: string
  let recipientId: string
  let authorId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    recipientId = await seedUser({ email: 'r@b.com', name: 'Rita' })
    recipientToken = await seedSession(recipientId)
    authorId = await seedUser({ email: 'a@b.com', name: 'Alice' })
  })

  async function mentionOn(billNumber: string, isDraft: boolean) {
    const billId = await seedBill({ billNumber, title: `${billNumber} title`, isDraft })
    const commentId = await seedComment(billId, authorId, '<p>Look at this.</p>')
    await seedCommentMention(commentId, recipientId, { sourceType: 'user', sourceId: recipientId })
  }

  async function mentions(): Promise<Array<Record<string, unknown>>> {
    const res = await SELF.fetch('http://localhost/api/notifications', {
      headers: { Cookie: `session=${recipientToken}` },
    })
    expect(res.status).toBe(200)
    return (await res.json() as { mentions: Array<Record<string, unknown>> }).mentions
  }

  it('emits billIsDraft: true for a mention on a draft bill', async () => {
    await mentionOn('D 1', true)
    const row = (await mentions()).find(m => m.billNumber === 'D 1')
    expect(row).toBeDefined()
    expect(row!.billIsDraft).toBe(true)
  })

  // Literal false, not an absent key: absent renders the solid badge and so
  // looks correct, which is exactly how a dropped select column would hide.
  it('emits billIsDraft: false — not undefined — for a filed bill', async () => {
    await mentionOn('F 1', false)
    const row = (await mentions()).find(m => m.billNumber === 'F 1')
    expect(row).toBeDefined()
    expect(row!.billIsDraft).toBe(false)
    expect('billIsDraft' in row!).toBe(true)
  })

  it('distinguishes the two within a single response', async () => {
    await mentionOn('D 2', true)
    await mentionOn('F 2', false)
    const all = await mentions()
    expect(all.find(m => m.billNumber === 'D 2')!.billIsDraft).toBe(true)
    expect(all.find(m => m.billNumber === 'F 2')!.billIsDraft).toBe(false)
  })
})
