import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { aliasedTable, eq } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { comments } from '../../src/db/schema'
import { getDb } from '../../src/db/client'
import { rowidOf } from '../../src/db/rowid'
import { clearDb, seedUser } from '../helpers'

const dialect = new SQLiteSyncDialect()
const render = (table: Parameters<typeof rowidOf>[0]) => dialect.sqlToQuery(rowidOf(table)).sql

describe('rowidOf', () => {
  it('renders the table name for comments', () => {
    expect(render(comments)).toBe('"comments"."rowid"')
  })

  it('renders the alias name for an aliased comments table', () => {
    expect(render(aliasedTable(comments, 'c'))).toBe('"c"."rowid"')
  })

  describe('against D1', () => {
    beforeEach(async () => {
      await clearDb()
    })

    it('resolves when the comments table is aliased', async () => {
      const userId = await seedUser({ role: 'owner' })
      await env.DB.prepare(
        "INSERT INTO bills (id, external_id, bill_number, title, state, session) VALUES ('b1', 'x:1', 'HB 1', 'T', 'MI', '2025-2026')",
      ).run()
      const at = '2026-08-01 12:00:00'
      for (const [id, body] of [['c1', 'question'], ['c2', 'answer']]) {
        await env.DB.prepare(
          'INSERT INTO comments (id, bill_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(id, 'b1', userId, `<p>${body}</p>`, at).run()
      }

      const c = aliasedTable(comments, 'c')
      const rows = await getDb(env.DB)
        .select({ id: c.id })
        .from(c)
        .where(eq(c.billId, 'b1'))
        .orderBy(c.createdAt, rowidOf(c))
        .all()

      expect(rows.map(r => r.id)).toEqual(['c1', 'c2'])
    })
  })
})
