import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedBill, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { billGroupOverrides, bills } from '../../src/db/schema'
import { previewSplit, splitFromGroup, syncIdenticalCompanions } from '../../src/lib/companionGroups'

// A split pair is a cannot-link (#382): two bills an admin split apart are never in one group, however the
// provider's links connect them, and the groups are a function of the stored
// links and overrides alone, so the order bills are delivered in never
// changes them. Random small instances, each delivered in two orders.

// A small deterministic generator, so a failure names its seed.
function random(seed: number) {
  let x = seed
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 }
}

type Instance = { links: Array<[number, number]>; splits: Array<[number, number]>; manual: Array<[number, number]>; dropped: Array<[number, number]> }

const BILLS = 7
const id = (i: number) => `b${i}`

function instance(seed: number): Instance {
  const r = random(seed)
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < BILLS; i++) for (let j = i + 1; j < BILLS; j++) pairs.push([i, j])
  const links: Array<[number, number]> = []
  const splits: Array<[number, number]> = []
  const manual: Array<[number, number]> = []
  for (const p of pairs) {
    const roll = r()
    if (roll < 0.3) links.push(p)
    else if (roll < 0.4) splits.push(p)
    else if (roll < 0.45) manual.push(p)
  }
  // Links the provider later stops naming.
  const dropped = links.filter(() => r() < 0.3)
  return { links, splits, manual, dropped }
}

async function settle(inst: Instance, order: number[], later: 'drop' | 'keep' = 'keep'): Promise<Array<string | null>> {
  await clearDb()
  const admin = await seedUser({ role: 'admin', email: 'ada@example.com', name: 'ada' })
  for (let i = 0; i < BILLS; i++) await seedBill({ id: id(i), billNumber: `B${i}`, state: 'NJ', externalId: `legiscan:${100 + i}` })
  const db = getDb(env.DB)
  for (const [kind, list] of [['split', inst.splits], ['link', inst.manual]] as const) {
    for (const [a, b] of list) await db.insert(billGroupOverrides).values({ billId: id(a), otherBillId: id(b), kind, actorUserId: admin })
  }
  // Each bill names the companions on its side of each link (the smaller one names the larger).
  const deliver = async (links: Array<[number, number]>) => {
    for (const i of order) {
      const named = links.filter(([a]) => a === i).map(([, b]) => ({ sastBillId: 100 + b, kind: 'identical' }))
      await syncIdenticalCompanions(db, `legiscan:${100 + i}`, named)
    }
  }
  await deliver(inst.links)
  // Then every bill is delivered again without the links the provider dropped.
  if (later === 'drop') await deliver(inst.links.filter(l => !inst.dropped.includes(l)))
  const rows = await db.select({ id: bills.id, k: bills.groupKey }).from(bills).all()
  return [...Array(BILLS).keys()].map(i => rows.find(r => r.id === id(i))!.k)
}

describe('split pairs as cannot-links', () => {
  it('give the same groups whichever order the bills arrive in, and never group a split pair', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const inst = instance(seed)
      const forward = await settle(inst, [...Array(BILLS).keys()])
      const backward = await settle(inst, [...Array(BILLS).keys()].reverse())
      expect(backward, `seed ${seed}`).toEqual(forward)
      // Dropping links later ends where the final links would have from the start.
      const final = { ...inst, links: inst.links.filter(l => !inst.dropped.includes(l)) }
      const fresh = await settle(final, [...Array(BILLS).keys()])
      expect(await settle(inst, [...Array(BILLS).keys()], 'drop'), `seed ${seed}, links dropped`).toEqual(fresh)
      expect(await settle(inst, [...Array(BILLS).keys()].reverse(), 'drop'), `seed ${seed}, links dropped, reversed`).toEqual(fresh)
      for (const [a, b] of inst.splits) {
        expect(forward[a] !== null && forward[a] === forward[b], `seed ${seed}: B${a} and B${b} were split`).toBe(false)
      }
    }
  }, 120_000)
})

describe('the split preview on random instances', () => {
  // The confirmation before a split names what the rest of the group will fall into. On each random
  // instance, for the bill in the largest group and for the last grouped bill, what previewSplit says
  // must be what a real split leaves.
  it('names the groups the rest fall into, as the real split leaves them', async () => {
    const order = [...Array(BILLS).keys()]
    for (let seed = 1; seed <= 10; seed++) {
      const inst = instance(seed)
      const grouped = (await settle(inst, order)).flatMap((k, i) => (k === null ? [] : [i]))
      if (grouped.length === 0) continue
      const sizes = new Map<number, number>()
      const keysNow = await settle(inst, order)
      for (const i of grouped) sizes.set(i, keysNow.filter(k => k === keysNow[i]).length)
      const biggest = [...grouped].sort((a, b) => sizes.get(b)! - sizes.get(a)! || a - b)[0]
      for (const target of new Set([biggest, grouped[grouped.length - 1]])) {
        const before = await settle(inst, order)
        const db = getDb(env.DB)
        const rest = [...Array(BILLS).keys()].filter(i => i !== target && before[i] !== null && before[i] === before[target])
        const preview = await previewSplit(db, id(target))
        expect(preview, `seed ${seed}, split B${target}`).not.toBeNull()
        const admin = (await db.select({ id: billGroupOverrides.actorUserId }).from(billGroupOverrides).get())?.id ?? (await seedUser({ role: 'admin', email: `a${seed}${target}@example.com`, name: 'ada' }))
        expect(await splitFromGroup(db, id(target), admin), `seed ${seed}, split B${target}`).toBe(true)
        const rows = await db.select({ id: bills.id, k: bills.groupKey }).from(bills).all()
        const key = (i: number) => rows.find(r => r.id === id(i))!.k ?? `alone:${i}`
        // Each group a bill of the rest fell into, with every bill now in it: the split can free a bill that
        // another split had kept out of the group, and the preview says so.
        const left = new Map<string, string[]>()
        for (const i of rest) left.set(key(i), [...Array(BILLS).keys()].filter(j => j !== target && key(j) === key(i)).map(j => `B${j}`))
        const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })
        const actual = [...left.values()].map(p => p.sort(byNumber)).sort((a, b) => byNumber(a[0], b[0]))
        expect(preview!.map(p => p.map(b => b.billNumber)), `seed ${seed}, split B${target}`).toEqual(actual)
      }
    }
  }, 240_000)
})
