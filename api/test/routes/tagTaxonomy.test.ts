import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'

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
