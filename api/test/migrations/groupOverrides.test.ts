import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0104 adds the pairs an admin grouped or split by hand (#382). It is a new
// table over no existing rows, so what it must get right is its constraints:
// a pair is stored once, smaller id first, as one kind, and goes with either
// bill.
describe('migration 0104: group overrides', () => {
  const insert = (billId: string, otherBillId: string, kind = 'link') =>
    env.DB.prepare('INSERT INTO bill_group_overrides (bill_id, other_bill_id, kind) VALUES (?, ?, ?)').bind(billId, otherBillId, kind).run()
  const rows = async () => (await env.DB.prepare('SELECT bill_id, other_bill_id, kind FROM bill_group_overrides ORDER BY bill_id, other_bill_id').all<{ bill_id: string; other_bill_id: string; kind: string }>()).results

  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0104_group_overrides' })
    // Raw SQL, since the app's schema already names what later migrations add.
    await env.DB.batch(['a190', 'b1713', 'c1714'].map(id =>
      env.DB.prepare('INSERT INTO bills (id, bill_number, title, state, external_id) VALUES (?, ?, ?, ?, ?)').bind(id, id.toUpperCase(), 't', 'NJ', `legiscan:${id}`)))
    await applyMigrations()
  })

  it('starts empty, so no instance has an override until an admin makes one', async () => {
    expect(await rows()).toEqual([])
  })

  it('stores a pair with the smaller id first, and refuses it the other way round', async () => {
    await insert('a190', 'b1713')
    await expect(insert('c1714', 'a190')).rejects.toThrow(/CHECK constraint failed/i)
    expect(await rows()).toEqual([{ bill_id: 'a190', other_bill_id: 'b1713', kind: 'link' }])
  })

  it('refuses a bill paired with itself', async () => {
    await expect(insert('a190', 'a190')).rejects.toThrow(/CHECK constraint failed/i)
  })

  it('refuses a kind that is neither link nor split', async () => {
    await expect(insert('a190', 'b1713', 'merge')).rejects.toThrow(/CHECK constraint failed/i)
    await insert('a190', 'b1713', 'split')
    expect(await rows()).toEqual([{ bill_id: 'a190', other_bill_id: 'b1713', kind: 'split' }])
  })

  it('holds one row per pair, so a pair is never both linked and split', async () => {
    await insert('a190', 'b1713', 'link')
    await expect(insert('a190', 'b1713', 'split')).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/i)
    expect(await rows()).toEqual([{ bill_id: 'a190', other_bill_id: 'b1713', kind: 'link' }])
  })

  it('refuses a pair naming a bill that does not exist', async () => {
    await expect(insert('a190', 'zzz')).rejects.toThrow(/FOREIGN KEY constraint failed/i)
    await expect(insert('0000', 'a190')).rejects.toThrow(/FOREIGN KEY constraint failed/i)
  })

  it('drops a pair when either of its bills is deleted, and leaves the other pairs', async () => {
    await insert('a190', 'b1713')
    await insert('a190', 'c1714', 'split')
    await insert('b1713', 'c1714')
    await env.DB.prepare("DELETE FROM bills WHERE id = 'a190'").run()
    expect(await rows()).toEqual([{ bill_id: 'b1713', other_bill_id: 'c1714', kind: 'link' }])
    await env.DB.prepare("DELETE FROM bills WHERE id = 'c1714'").run()
    expect(await rows()).toEqual([])
  })

  it('fills the actor and the time when they are left out, and keeps an actor that is not a user', async () => {
    await insert('a190', 'b1713')
    const row = await env.DB.prepare('SELECT actor_user_id, created_at FROM bill_group_overrides').first<{ actor_user_id: string | null; created_at: string }>()
    expect(row!.actor_user_id).toBeNull()
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('finds the pairs a bill is in from either side through an index', async () => {
    const plan = async (sql: string) => (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map(r => r.detail).join('\n')
    expect(await plan("SELECT kind FROM bill_group_overrides WHERE bill_id = 'a190'")).not.toMatch(/SCAN/)
    expect(await plan("SELECT kind FROM bill_group_overrides WHERE other_bill_id = 'a190'")).toContain('idx_bill_group_overrides_other')
  })

  it('leaves its rows alone when the migrations are applied again over a database that holds them', async () => {
    await insert('a190', 'b1713')
    await insert('a190', 'c1714', 'split')
    await applyMigrations()
    expect(await rows()).toEqual([
      { bill_id: 'a190', other_bill_id: 'b1713', kind: 'link' },
      { bill_id: 'a190', other_bill_id: 'c1714', kind: 'split' },
    ])
  })
})
