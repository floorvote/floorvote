import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedBill, seedUser, seedSession } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'
import { LM_COMPANION_BILLS } from '../../src/lib/demoSeeds/lakeMichigan/bills'
import { centralFetch } from '../../src/lib/centralFetch'

// Companion groups on the demo (#867): the seed engages four groups on the
// companion side, so a group's page interleaves both bills' comments.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

const seed = DEMO_SEEDS['lake-michigan']
const idOf = (externalId: string) => `bill-${externalId}`
const companionIds = LM_COMPANION_BILLS.map(c => `'${idOf(c.externalId)}'`).join(',')

async function seedTracked() {
  for (const [i, p] of seed.priorities.entries()) {
    await seedBill({ id: idOf(p.externalId), externalId: p.externalId, billNumber: `B${1000 + i}`, title: `Bill ${i}`, state: 'MI', priority: null })
  }
}

async function seedCompanions() {
  for (const c of LM_COMPANION_BILLS) {
    await seedBill({ id: idOf(c.externalId), externalId: c.externalId, billNumber: c.billNumber, title: c.billNumber, state: c.jurisdiction })
    const key = [idOf(c.externalId), idOf(c.companionOf)].sort()[0]
    await env.DB.prepare('UPDATE bills SET group_key = ? WHERE id IN (?, ?)').bind(key, idOf(c.externalId), idOf(c.companionOf)).run()
  }
}

const count = async (table: string, where = '1') =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n

const onCompanion = (externalId: string) => LM_COMPANION_BILLS.some(c => c.externalId === externalId)

describe('the lake-michigan companion seed', () => {
  beforeEach(async () => {
    await clearDb()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    await seedTracked()
  })

  it('names four companion bills, each with a seeded thread, two votes, and a note', () => {
    expect(LM_COMPANION_BILLS).toHaveLength(4)
    const tracked = new Set(seed.priorities.map(p => p.externalId))
    for (const c of LM_COMPANION_BILLS) {
      expect(tracked.has(c.companionOf), c.billNumber).toBe(true)
      expect(tracked.has(c.externalId), c.billNumber).toBe(false)
      expect(seed.comments.filter(x => x.externalId === c.externalId).length, `${c.billNumber} comments`).toBeGreaterThanOrEqual(2)
      expect(seed.votes.filter(x => x.externalId === c.externalId).length, `${c.billNumber} votes`).toBeGreaterThanOrEqual(2)
      expect(seed.notes.filter(x => x.externalId === c.externalId).length, `${c.billNumber} notes`).toBe(1)
    }
  })

  it('gives every chosen group a priority and an official position', () => {
    expect(LM_COMPANION_BILLS).toHaveLength(4)
    for (const c of LM_COMPANION_BILLS) {
      const members = [c.externalId, c.companionOf]
      expect(seed.priorities.some(p => members.includes(p.externalId)), c.billNumber).toBe(true)
      expect(seed.positions.some(p => members.includes(p.externalId)), c.billNumber).toBe(true)
    }
  })

  it('no-ops every companion row when the companion bills are not in the tenant', async () => {
    expect(LM_COMPANION_BILLS).toHaveLength(4)
    await runDemoReset(env.DB, seed)
    for (const table of ['comments', 'member_votes', 'notes', 'feed_events']) {
      expect(await count(table, `bill_id IN (${companionIds})`), table).toBe(0)
    }
    expect(await count('comments')).toBe(seed.comments.filter(c => !onCompanion(c.externalId)).length)
  })

  it("serves a group's comments from both bills, oldest first, and counts member votes across the group", async () => {
    expect(LM_COMPANION_BILLS).toHaveLength(4)
    await seedCompanions()
    await runDemoReset(env.DB, seed)
    const viewer = await seedUser({ role: 'admin' })
    const cookie = `session=${await seedSession(viewer)}`
    for (const c of LM_COMPANION_BILLS) {
      const res = await SELF.fetch(`https://x/api/bills/${idOf(c.companionOf)}`, { headers: { Cookie: cookie } })
      expect(res.status).toBe(200)
      const body = await res.json() as {
        comments: Array<{ billId: string; createdAt: string }>
        voteCounts: { total: number }
      }
      const ids = new Set(body.comments.map(x => x.billId))
      expect(ids, c.billNumber).toEqual(new Set([idOf(c.companionOf), idOf(c.externalId)]))
      const times = body.comments.map(x => x.createdAt)
      expect(times).toEqual([...times].sort())
      const members = [c.externalId, c.companionOf]
      expect(body.voteCounts.total, c.billNumber)
        .toBe(new Set(seed.votes.filter(v => members.includes(v.externalId)).map(v => v.userId)).size)
    }
  })

  it('leaves no one voting on both bills of a group', () => {
    expect(LM_COMPANION_BILLS).toHaveLength(4)
    for (const c of LM_COMPANION_BILLS) {
      const mine = new Set(seed.votes.filter(v => v.externalId === c.externalId).map(v => v.userId))
      for (const v of seed.votes.filter(v => v.externalId === c.companionOf)) expect(mine.has(v.userId), `${c.billNumber} ${v.userId}`).toBe(false)
    }
  })
})
