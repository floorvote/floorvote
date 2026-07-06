import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { officialPositions } from '../../src/db/schema'

describe('"Any" (has-value) filter — position + custom fields', () => {
  let token: string
  let adminId: string
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'a@e.com' })
    token = await seedSession(adminId)
  })

  it('position=__any__ returns only bills with a position; facet count matches', async () => {
    const withPos = await seedBill({ billNumber: 'P1' })
    await seedBill({ billNumber: 'P2' }) // no position
    await getDb(env.DB).insert(officialPositions).values({ id: crypto.randomUUID(), billId: withPos, position: 'Support', setBy: adminId })

    const list = await (await SELF.fetch('http://localhost/api/bills?position=__any__', { headers: { Cookie: `session=${token}` } })).json() as { bills: { billNumber: string }[] }
    expect(list.bills.map(b => b.billNumber).sort()).toEqual(['P1'])

    const facets = await (await SELF.fetch('http://localhost/api/bills/facets', { headers: { Cookie: `session=${token}` } })).json() as { position: Record<string, number> }
    expect(facets.position['__any__']).toBe(1)
  })

  it('priority __any__ / none filter + facet counts', async () => {
    await seedBill({ billNumber: 'PR1', priority: 'high' })
    await seedBill({ billNumber: 'PR2', priority: 'low' })
    await seedBill({ billNumber: 'PR3' }) // no priority

    const any = await (await SELF.fetch('http://localhost/api/bills?priority=__any__', { headers: { Cookie: `session=${token}` } })).json() as { bills: { billNumber: string }[] }
    expect(any.bills.map(b => b.billNumber).sort()).toEqual(['PR1', 'PR2'])

    const none = await (await SELF.fetch('http://localhost/api/bills?priority=none', { headers: { Cookie: `session=${token}` } })).json() as { bills: { billNumber: string }[] }
    expect(none.bills.map(b => b.billNumber).sort()).toEqual(['PR3'])

    const facets = await (await SELF.fetch('http://localhost/api/bills/facets', { headers: { Cookie: `session=${token}` } })).json() as { priority: Record<string, number> }
    expect(facets.priority['__any__']).toBe(2)
    expect(facets.priority['none']).toBe(1)
  })

  it('tag __any__ filter + facet count', async () => {
    await seedBill({ billNumber: 'T1', tags: ['Elections'] })
    await seedBill({ billNumber: 'T2', tags: ['Elections', 'Funding'] })
    await seedBill({ billNumber: 'T3' }) // no tags

    const any = await (await SELF.fetch('http://localhost/api/bills?tag=__any__', { headers: { Cookie: `session=${token}` } })).json() as { bills: { billNumber: string }[] }
    expect(any.bills.map(b => b.billNumber).sort()).toEqual(['T1', 'T2'])

    const facets = await (await SELF.fetch('http://localhost/api/bills/facets', { headers: { Cookie: `session=${token}` } })).json() as { tags: Record<string, number> }
    expect(facets.tags['__any__']).toBe(2) // distinct bills with a tag
  })

  it('cf_<field>=__any__ returns bills with any value; facet count is distinct bills', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/custom-fields', {
      method: 'POST', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tags', type: 'dropdown', options: ['a', 'b'], multiple: true }),
    })
    const { id: fieldId } = await res.json() as { id: string }
    const b1 = await seedBill({ billNumber: 'C1' })
    const b2 = await seedBill({ billNumber: 'C2' })
    await seedBill({ billNumber: 'C3' }) // no value
    await SELF.fetch(`http://localhost/api/bills/${b1}/custom-fields`, { method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ [fieldId]: ['a', 'b'] }) })
    await SELF.fetch(`http://localhost/api/bills/${b2}/custom-fields`, { method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ [fieldId]: ['a'] }) })

    const list = await (await SELF.fetch(`http://localhost/api/bills?cf_${fieldId}=__any__`, { headers: { Cookie: `session=${token}` } })).json() as { bills: { billNumber: string }[] }
    expect(list.bills.map(b => b.billNumber).sort()).toEqual(['C1', 'C2'])

    const facets = await (await SELF.fetch('http://localhost/api/bills/facets', { headers: { Cookie: `session=${token}` } })).json() as { customFields: Record<string, Record<string, number>> }
    expect(facets.customFields[fieldId]['__any__']).toBe(2) // distinct bills, not 3 (C1 has two values)
  })
})
