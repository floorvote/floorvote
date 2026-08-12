import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'

describe('GET /api/bills/:id — same-day comment ordering', () => {
  let cookie: string
  let userId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ role: 'owner' })
    cookie = `session=${await seedSession(userId)}`
  })

  it('pins the reading order of same-second comments (characterization)', async () => {
    const at = '2026-08-01 12:00:00'
    await env.DB.prepare(
      "INSERT INTO bills (id, external_id, bill_number, title, state, session) VALUES ('b1', 'x:1', 'HB 1', 'T', 'MI', '2025-2026')",
    ).run()
    // Same-second comments share one created_at because daysAgoDb truncates to
    // seconds. The route asks for ORDER BY created_at, rowid to keep a question,
    // its answer, and a follow-up in insert order when that happens. On SQLite
    // today, the temp b-tree sorter already yields rowid order for tied keys with
    // or without the explicit tiebreaker — so this test does not fail if the
    // tiebreaker is removed. It pins the contract for a future plan change (an
    // index on created_at, a different engine) that would make ties
    // non-deterministic.
    for (const [id, body] of [['c1', 'question'], ['c2', 'answer'], ['c3', 'follow-up']]) {
      await env.DB.prepare(
        'INSERT INTO comments (id, bill_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(id, 'b1', userId, `<p>${body}</p>`, at).run()
    }

    const res = await app.request('/api/bills/b1', { headers: { Cookie: cookie } }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { comments: { content: string }[] }
    expect(body.comments.map(c => c.content)).toEqual([
      '<p>question</p>', '<p>answer</p>', '<p>follow-up</p>',
    ])
  })
})
