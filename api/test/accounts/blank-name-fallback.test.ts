import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedComment, seedCommentMention } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, billCustomFieldValues, commentReactions, customFieldDefinitions, feedEvents, memberVotes, officialPositions } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { extractAndNotifyMentions } from '../../src/lib/mentions'

// A user can clear their name (#233). Everywhere the server hands a person's
// name to a reader, a blank name falls back to the email address, the same way
// it already does for users who never set a name.

const CLEARED_EMAIL = 'cleared@example.com'

let viewerId: string
let viewerToken: string
let clearedId: string
let billId: string

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  viewerId = await seedUser({ role: 'admin', name: 'Viewer Person', email: 'viewer@example.com' })
  viewerToken = await seedSession(viewerId)
  clearedId = await seedUser({ role: 'member', name: 'Old Name', email: CLEARED_EMAIL })
  const clearedToken = await seedSession(clearedId)
  // Clear the name through the real endpoint rather than seeding a blank one.
  const res = await SELF.fetch('http://localhost/api/users/me', {
    method: 'PATCH',
    headers: { Cookie: `session=${clearedToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '' }),
  })
  expect(res.status).toBe(200)
  billId = await seedBill({ billNumber: 'HB 7', state: 'RI', session: '2026', priority: 'high', title: 'Fallback bill' })
})

afterEach(() => { vi.unstubAllGlobals() })

function get(path: string) {
  return SELF.fetch(`http://localhost/api${path}`, { headers: { Cookie: `session=${viewerToken}` } })
}

describe('a cleared name falls back to the email', () => {
  it('in mention notifications (authorName)', async () => {
    const commentId = await seedComment(billId, clearedId, '<p>Hello</p>')
    await seedCommentMention(commentId, viewerId, { sourceType: 'user', sourceId: viewerId })
    const body = await (await get('/notifications')).json() as { mentions: Array<{ authorName: string }> }
    expect(body.mentions).toHaveLength(1)
    expect(body.mentions[0].authorName).toBe(CLEARED_EMAIL)
  })

  it('in comment authors on bill detail and the comments list', async () => {
    await seedComment(billId, clearedId, '<p>Hello</p>')
    const detail = await (await get(`/bills/${billId}`)).json() as { comments: Array<{ userName: string }> }
    expect(detail.comments[0].userName).toBe(CLEARED_EMAIL)
    const list = await (await get(`/bills/${billId}/comments`)).json() as Array<{ userName: string }>
    expect(list[0].userName).toBe(CLEARED_EMAIL)
  })

  it('in comment reactor names on bill detail and the comments list', async () => {
    const commentId = await seedComment(billId, viewerId, '<p>Hello</p>')
    await getDb(env.DB).insert(commentReactions).values({ id: crypto.randomUUID(), commentId, userId: clearedId, emoji: '👍' })
    type R = { reactions: Array<{ reactors: { name: string }[] }> }
    const detail = await (await get(`/bills/${billId}`)).json() as { comments: R[] }
    expect(detail.comments[0].reactions[0].reactors).toEqual([{ name: CLEARED_EMAIL, subtitle: null }])
    const list = await (await get(`/bills/${billId}/comments`)).json() as R[]
    expect(list[0].reactions[0].reactors).toEqual([{ name: CLEARED_EMAIL, subtitle: null }])
  })

  it('in "Set by" for priority', async () => {
    await getDb(env.DB).insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'priority_set', billId, userId: clearedId, metadata: '{}',
    })
    const body = await (await get(`/bills/${billId}`)).json() as { priorityMeta: { setByName: string } | null }
    expect(body.priorityMeta?.setByName).toBe(CLEARED_EMAIL)
  })

  it('in "Set by" for the official position', async () => {
    await getDb(env.DB).insert(officialPositions).values({ id: crypto.randomUUID(), billId, position: 'Support', setBy: clearedId })
    const body = await (await get(`/bills/${billId}`)).json() as { position: { setByName: string } | null }
    expect(body.position?.setByName).toBe(CLEARED_EMAIL)
  })

  it('in "Set by" for custom field values', async () => {
    const db = getDb(env.DB)
    await db.insert(customFieldDefinitions).values({ id: 'f-text', name: 'Notes field', type: 'text', displayOrder: 0 })
    await db.insert(billCustomFieldValues).values({ billId, fieldId: 'f-text', value: 'x', setBy: clearedId })
    const body = await (await get(`/bills/${billId}`)).json() as { customFieldValues: Record<string, { setBy: string }> }
    expect(body.customFieldValues['f-text'].setBy).toBe(CLEARED_EMAIL)
  })

  // Member votes keep their existing contract (billsApi.test.ts): a blank
  // userName plus userEmail, and the page renders `userName || userEmail`.
  it('in member votes shown to admins, by sending the email alongside a blank userName', async () => {
    await getDb(env.DB).insert(memberVotes).values({ id: crypto.randomUUID(), userId: clearedId, billId, position: 'support' })
    const body = await (await get(`/bills/${billId}`)).json() as { memberVotes: Array<{ userName: string; userEmail: string }> }
    expect(body.memberVotes).toEqual([expect.objectContaining({ userName: '', userEmail: CLEARED_EMAIL })])
  })

  it('in the activity feed', async () => {
    await getDb(env.DB).insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'comment_added', billId, userId: clearedId,
      metadata: JSON.stringify({ preview: 'Feed preview' }),
    })
    const res = await get('/feed')
    const text = await res.text()
    expect(text).toContain(CLEARED_EMAIL)
    expect(text).not.toContain('Old Name')
  })

  it('in the daily digest email', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'comment_added', billId, userId: clearedId,
      metadata: JSON.stringify({ preview: 'Digest preview text' }),
    })
    const calls: Array<{ to: string[]; html: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 })
    }))
    await runDigest(env as never, db)
    expect(calls.length).toBeGreaterThan(0)
    const html = calls[0].html
    expect(html).toContain('Digest preview text')
    expect(html).toContain(`${CLEARED_EMAIL}: `)
    expect(html).not.toContain('Old Name')
  })

  it('in the @mention email sent to the mentioned user', async () => {
    const calls: Array<{ to: string[]; html: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 })
    }))
    const html = `<p>Hi <span data-type="mention" data-id="user:${viewerId}" data-label="Viewer Person">@Viewer Person</span></p>`
    const commentId = await seedComment(billId, clearedId, html)
    const tasks: Promise<unknown>[] = []
    await extractAndNotifyMentions(commentId, html, clearedId, 'member', billId, env as never, p => { tasks.push(p) })
    await Promise.all(tasks)
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toEqual(['viewer@example.com'])
    expect(calls[0].html).toContain(`${CLEARED_EMAIL}</strong> mentioned you in a comment`)
    expect(calls[0].html).not.toMatch(/<strong[^>]*><\/strong> mentioned you/)
  })
})
