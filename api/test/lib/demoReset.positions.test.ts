import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedBill, seedUser, seedSession } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'
import { LM_COMPANION_BILLS } from '../../src/lib/demoSeeds/lakeMichigan/bills'
import { centralFetch } from '../../src/lib/centralFetch'

// A seeded position's "Set by … · 2m ago" reads official_positions.updated_at
// (detail.ts, through lib/teamFields.ts). The reset wrote only created_at, so
// updated_at took its default, the reset's own moment, and every seeded position
// read as set minutes ago (#884).

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

const seed = DEMO_SEEDS['lake-michigan']
const idOf = (externalId: string) => `bill-${externalId}`

async function seedBills() {
  for (const [i, p] of seed.priorities.entries()) {
    await seedBill({ id: idOf(p.externalId), externalId: p.externalId, billNumber: `B${1000 + i}`, title: `Bill ${i}`, state: 'MI', priority: null })
  }
  for (const c of LM_COMPANION_BILLS) {
    await seedBill({ id: idOf(c.externalId), externalId: c.externalId, billNumber: c.billNumber, title: c.billNumber, state: c.jurisdiction })
    const key = [idOf(c.externalId), idOf(c.companionOf)].sort()[0]
    await env.DB.prepare('UPDATE bills SET group_key = ? WHERE id IN (?, ?)').bind(key, idOf(c.externalId), idOf(c.companionOf)).run()
  }
}

/** The instant a seeded position says it was set, as the reset computes it. */
const seededAt = (p: { daysAgo: number; minutesLater?: number }) =>
  Date.now() - p.daysAgo * 86400_000 + (p.minutesLater ?? 0) * 60_000

const asInstant = (stored: string) => Date.parse(`${stored.replace(' ', 'T')}Z`)
/** The reset and the assertion run seconds apart; a minute is far inside the seed's own spacing. */
const TOLERANCE_MS = 60_000

async function detailPosition(billId: string, cookie: string) {
  const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: cookie } })
  expect(res.status).toBe(200)
  const body = await res.json() as { position: { position: string; setByName: string; updatedAt: string } | null }
  return body.position
}

describe('the demo reset and the official position set time', () => {
  // The reset replaces the tenant's users and sessions, so a viewer signs in after it.
  let cookie: string
  const resetAndSignIn = async () => {
    await runDemoReset(env.DB, seed)
    cookie = `session=${await seedSession(await seedUser({ role: 'admin' }))}`
  }

  beforeEach(async () => {
    await clearDb()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    await seedBills()
  })

  it('writes updated_at from the seed, equal to created_at, on every seeded position', async () => {
    await runDemoReset(env.DB, seed)
    const rows = (await env.DB.prepare('SELECT id, created_at, updated_at FROM official_positions').all<{ id: string; created_at: string; updated_at: string }>()).results
    expect(rows).toHaveLength(seed.positions.length)
    for (const row of rows) {
      expect(row.updated_at, row.id).toBe(row.created_at)
      const p = seed.positions.find(x => x.id === row.id)!
      expect(Math.abs(asInstant(row.updated_at) - seededAt(p)), row.id).toBeLessThan(TOLERANCE_MS)
    }
  })

  it("shows each seeded position's own daysAgo on the bill it sits on", async () => {
    await resetAndSignIn()
    const grouped = new Set(LM_COMPANION_BILLS.flatMap(c => [c.externalId, c.companionOf]))
    const plain = seed.positions.filter(p => !grouped.has(p.externalId))
    expect(plain.length).toBeGreaterThan(0)
    for (const p of plain) {
      const shown = await detailPosition(idOf(p.externalId), cookie)
      expect(shown, p.id).not.toBeNull()
      expect(Math.abs(asInstant(shown!.updatedAt) - seededAt(p)), p.id).toBeLessThan(TOLERANCE_MS)
    }
  })

  it("shows the seed's date on a position that reads set a long time ago, not one near the reset", async () => {
    await resetAndSignIn()
    const old = seed.positions.find(p => p.daysAgo >= 365)!
    const shown = await detailPosition(idOf(old.externalId), cookie)
    expect(Date.now() - asInstant(shown!.updatedAt)).toBeGreaterThan(300 * 86400_000)
  })

  it("shows a companion group's newest seeded position on both of its bills", async () => {
    await resetAndSignIn()
    expect(LM_COMPANION_BILLS).toHaveLength(4)
    for (const c of LM_COMPANION_BILLS) {
      const members = [c.externalId, c.companionOf]
      const seeded = seed.positions.filter(p => members.includes(p.externalId))
      expect(seeded.length, c.billNumber).toBeGreaterThan(0)
      const newest = Math.max(...seeded.map(seededAt))
      for (const m of members) {
        const shown = await detailPosition(idOf(m), cookie)
        expect(shown, `${c.billNumber} ${m}`).not.toBeNull()
        expect(Math.abs(asInstant(shown!.updatedAt) - newest), `${c.billNumber} ${m}`).toBeLessThan(TOLERANCE_MS)
      }
    }
  })

  it('still names the seeded setter', async () => {
    await resetAndSignIn()
    const p = seed.positions.find(x => x.id === 'lm-pos-5')!
    const shown = await detailPosition(idOf(p.externalId), cookie)
    expect(shown!.position).toBe('Support')
  })

  it('reads the seed again after a second reset, not the moment of either', async () => {
    await runDemoReset(env.DB, seed)
    await runDemoReset(env.DB, seed)
    const rows = (await env.DB.prepare('SELECT id, updated_at FROM official_positions').all<{ id: string; updated_at: string }>()).results
    expect(rows).toHaveLength(seed.positions.length)
    for (const row of rows) {
      const p = seed.positions.find(x => x.id === row.id)!
      expect(Math.abs(asInstant(row.updated_at) - seededAt(p)), row.id).toBeLessThan(TOLERANCE_MS)
    }
  })
})
