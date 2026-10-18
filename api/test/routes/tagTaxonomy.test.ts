import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

async function seedTaxonomy(names: string[]) {
  await getDb(env.DB).insert(associationConfig).values({
    key: 'tag_taxonomy', value: JSON.stringify(names.map(name => ({ name }))),
  })
}

describe('tag taxonomy filtering — chips', () => {
  let token: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'a@e.com' })
    token = await seedSession(adminId)
    await seedTaxonomy(['Elections'])
  })

  it('GET /bills drops tags not in the current taxonomy from the chip list', async () => {
    await seedBill({ billNumber: 'B1', tags: ['Elections', 'Land Records'] })
    const res = await SELF.fetch('http://localhost/api/bills', { headers: { Cookie: `session=${token}` } })
    const body = await res.json() as { bills: { billNumber: string; tags: string[] }[] }
    expect(body.bills.find(b => b.billNumber === 'B1')!.tags).toEqual(['Elections'])
  })

  it('GET /bills/:id drops tags not in the current taxonomy', async () => {
    const id = await seedBill({ billNumber: 'B2', tags: ['Land Records', 'Elections'] })
    const res = await SELF.fetch(`http://localhost/api/bills/${id}`, { headers: { Cookie: `session=${token}` } })
    const body = await res.json() as { tags: string[] }
    expect(body.tags).toEqual(['Elections'])
  })
})

describe('tag taxonomy filtering — facets', () => {
  let token: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'a@e.com' })
    token = await seedSession(adminId)
    await getDb(env.DB).insert(associationConfig).values({
      key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Elections' }]),
    })
  })

  it('facets omit removed tags and count "Any tag" over valid tags only', async () => {
    await seedBill({ billNumber: 'F1', tags: ['Elections'] })
    await seedBill({ billNumber: 'F2', tags: ['Land Records'] })
    await seedBill({ billNumber: 'F3', tags: ['Elections', 'Land Records'] })

    const res = await SELF.fetch('http://localhost/api/bills/facets', { headers: { Cookie: `session=${token}` } })
    const body = await res.json() as { tags: Record<string, number> }
    expect(body.tags['Elections']).toBe(2)          // F1 + F3
    expect(body.tags['Land Records']).toBeUndefined() // removed tag never surfaces
    expect(body.tags['__any__']).toBe(2)            // F1, F3 have a valid tag; F2 does not
  })
})

describe('tag taxonomy filtering — "Any tag" list filter', () => {
  let token: string
  const get = (qs: string) => SELF.fetch(`http://localhost/api/bills${qs}`, { headers: { Cookie: `session=${token}` } })
  const names = async (qs: string) => {
    const body = await (await get(qs)).json() as { bills: { billNumber: string }[]; pagination: { total: number } }
    return { numbers: body.bills.map(b => b.billNumber).sort(), total: body.pagination.total }
  }
  const anyFacet = async (qs = '') => {
    const res = await SELF.fetch(`http://localhost/api/bills/facets${qs}`, { headers: { Cookie: `session=${token}` } })
    return ((await res.json()) as { tags: Record<string, number> }).tags['__any__']
  }

  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'a@e.com' })
    token = await seedSession(adminId)
  })

  describe('with a configured taxonomy of one tag', () => {
    beforeEach(async () => {
      await seedTaxonomy(['Elections'])
      await seedBill({ billNumber: 'F1', tags: ['Elections'], state: 'RI' })
      await seedBill({ billNumber: 'F2', tags: ['Land Records'], state: 'RI' }) // tag since removed from the taxonomy
      await seedBill({ billNumber: 'F3', tags: ['Elections', 'Land Records'], state: 'CT' })
      await seedBill({ billNumber: 'F4', tags: [], state: 'CT' })
    })

    it('tag=__any__ leaves out a bill whose only tags are out of the taxonomy', async () => {
      expect((await names('?tag=__any__')).numbers).toEqual(['F1', 'F3'])
    })

    it('the "Any tag" facet count equals the list total for tag=__any__', async () => {
      const { total } = await names('?tag=__any__')
      expect(total).toBe(2)
      expect(await anyFacet()).toBe(total)
    })

    it('tag=__any__ with a named tag returns the bills with a valid tag or the named one', async () => {
      expect((await names('?tag=__any__&tag=Elections')).numbers).toEqual(['F1', 'F3'])
    })

    it('tag=__any__ with a named tag that left the taxonomy still matches that tag', async () => {
      expect((await names('?tag=__any__&tag=Land%20Records')).numbers).toEqual(['F1', 'F2', 'F3'])
    })

    it('a named tag alone still matches a bill with that tag after it left the taxonomy', async () => {
      expect((await names('?tag=Land%20Records')).numbers).toEqual(['F2', 'F3'])
    })

    it('under match=any, tag=__any__ ORs with another fact and the facet count equals the list total', async () => {
      const { numbers, total } = await names('?tag=__any__&state=CT&match=any')
      expect(numbers).toEqual(['F1', 'F3', 'F4'])
      expect(await anyFacet('?tag=__any__&state=CT&match=any')).toBe(total)
    })

    it('under the default AND mode, tag=__any__ narrows another fact and the facet count equals the list total', async () => {
      const { numbers, total } = await names('?tag=__any__&state=RI')
      expect(numbers).toEqual(['F1'])
      expect(await anyFacet('?tag=__any__&state=RI')).toBe(total)
    })
  })

  it('a bill with only tags that left the taxonomy is not matched, and the facet agrees', async () => {
    await seedTaxonomy(['Elections'])
    await seedBill({ billNumber: 'G1', tags: ['Land Records'] })
    await seedBill({ billNumber: 'G2', tags: ['Zoning'] })
    expect(await names('?tag=__any__')).toEqual({ numbers: [], total: 0 })
    expect(await anyFacet()).toBe(0)
  })

  it('with no configured taxonomy, the defaults apply: a default tag is matched and a non-default tag is not', async () => {
    await seedBill({ billNumber: 'D1', tags: ['Education'] })
    await seedBill({ billNumber: 'D2', tags: ['Land Records'] })
    await seedBill({ billNumber: 'D3', tags: [] })
    const { numbers, total } = await names('?tag=__any__')
    expect(numbers).toEqual(['D1'])
    expect(await anyFacet()).toBe(total)
  })

  it('a removed tag that is then added back to the taxonomy matches again', async () => {
    await seedTaxonomy(['Elections'])
    await seedBill({ billNumber: 'R1', tags: ['Land Records'] })
    expect((await names('?tag=__any__')).total).toBe(0)
    await getDb(env.DB).update(associationConfig)
      .set({ value: JSON.stringify([{ name: 'Elections' }, { name: 'Land Records' }]) })
      .where(eq(associationConfig.key, 'tag_taxonomy'))
    const after = await names('?tag=__any__')
    expect(after.numbers).toEqual(['R1'])
    expect(await anyFacet()).toBe(after.total)
  })
})

describe('tag taxonomy filtering — bulk filter', () => {
  let token: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'a@e.com' })
    token = await seedSession(adminId)
    await seedTaxonomy(['Elections'])
    await seedBill({ billNumber: 'F1', tags: ['Elections'] })
    await seedBill({ billNumber: 'F2', tags: ['Land Records'] })
    await seedBill({ billNumber: 'F3', tags: ['Elections', 'Land Records'] })
    await seedBill({ billNumber: 'F4', tags: [] })
  })

  const bulk = (path: string, init?: RequestInit) =>
    SELF.fetch(`http://localhost/api/bills${path}`, { headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' }, ...init })

  it('POST /bulk with filter.tag ["__any__"] edits the same bills the list shows', async () => {
    const list = await (await bulk('?tag=__any__')).json() as { pagination: { total: number } }
    const res = await bulk('/bulk', { method: 'POST', body: JSON.stringify({ filter: 'tag=__any__', priority: 'high' }) })
    expect(res.status).toBe(200)
    expect((await res.json() as { updated: number }).updated).toBe(list.pagination.total)
    const rows = await getDb(env.DB).select({ n: bills.billNumber, p: bills.priority }).from(bills).all()
    expect(rows.filter(r => r.p === 'high').map(r => r.n).sort()).toEqual(['F1', 'F3'])
  })
})

describe('public /config exposes tagTaxonomy', () => {
  it('returns the configured taxonomy tag names', async () => {
    await resetDb(); await applyMigrations()
    const uid = await seedUser({ role: 'member', email: 'm@e.com' })
    const token = await seedSession(uid)
    await getDb(env.DB).insert(associationConfig).values({
      key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Elections' }, { name: 'Public Records' }]),
    })
    const res = await SELF.fetch('http://localhost/api/config', { headers: { Cookie: `session=${token}` } })
    const body = await res.json() as { tagTaxonomy: string[] }
    expect(body.tagTaxonomy).toEqual(['Elections', 'Public Records'])
  })
})
