import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { customFieldDefinitions, billCustomFieldValues } from '../../src/db/schema'
import { and, eq } from 'drizzle-orm'

async function makeMultiField(name: string, options: string[]): Promise<string> {
  const adminId = await seedUser({ role: 'owner' })
  const adminToken = await seedSession(adminId)
  const res = await SELF.fetch('http://localhost/api/admin/custom-fields', {
    method: 'POST',
    headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'dropdown', options, multiple: true }),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { id: string; multiple: boolean }
  expect(body.multiple).toBe(true)
  return body.id
}

describe('multi-select custom fields', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('POST creates a multi=true field', async () => {
    await makeMultiField('Tags', ['urgent', 'legal-review', 'monitor'])
  })

  it('writes and reads array values', async () => {
    const fieldId = await makeMultiField('Tags', ['urgent', 'legal-review', 'monitor'])
    const billId = await seedBill()
    const adminId = await seedUser({ role: 'owner', email: 'a2@example.com' })
    const token = await seedSession(adminId)

    const putRes = await SELF.fetch(`http://localhost/api/bills/${billId}/custom-fields`, {
      method: 'PUT',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['urgent', 'legal-review'] }),
    })
    expect(putRes.status).toBe(200)

    const db = getDb(env.DB)
    const row = await db.select().from(billCustomFieldValues)
      .where(and(eq(billCustomFieldValues.billId, billId), eq(billCustomFieldValues.fieldId, fieldId)))
      .get()
    expect(row?.value).toBe(JSON.stringify(['urgent', 'legal-review']))
  })

  it('rejects array values containing unknown options', async () => {
    const fieldId = await makeMultiField('Tags', ['a', 'b'])
    const billId = await seedBill()
    const adminId = await seedUser({ role: 'owner', email: 'a3@example.com' })
    const token = await seedSession(adminId)

    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/custom-fields`, {
      method: 'PUT',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a', 'c'] }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; invalid: string[] }
    expect(body.error).toBe('invalid_options')
    expect(body.invalid).toEqual(['c'])
  })

  it('deletes row when array is empty', async () => {
    const fieldId = await makeMultiField('Tags', ['a', 'b'])
    const billId = await seedBill()
    const adminId = await seedUser({ role: 'owner', email: 'a4@example.com' })
    const token = await seedSession(adminId)

    await SELF.fetch(`http://localhost/api/bills/${billId}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a'] }),
    })
    await SELF.fetch(`http://localhost/api/bills/${billId}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: [] }),
    })

    const db = getDb(env.DB)
    const row = await db.select().from(billCustomFieldValues)
      .where(and(eq(billCustomFieldValues.billId, billId), eq(billCustomFieldValues.fieldId, fieldId)))
      .get()
    expect(row).toBeUndefined()
  })

  it('blocks multi→single switch when bills have 2+ values', async () => {
    const fieldId = await makeMultiField('Tags', ['a', 'b'])
    const billId = await seedBill()
    const adminId = await seedUser({ role: 'owner', email: 'a5@example.com' })
    const token = await seedSession(adminId)

    await SELF.fetch(`http://localhost/api/bills/${billId}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a', 'b'] }),
    })

    const res = await SELF.fetch(`http://localhost/api/admin/custom-fields/${fieldId}`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ multiple: false }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; billIds: string[] }
    expect(body.error).toBe('multi_to_single_conflict')
    expect(body.billIds).toContain(billId)
  })

  it('allows multi→single when no conflicts', async () => {
    const fieldId = await makeMultiField('Tags', ['a', 'b'])
    const billId = await seedBill()
    const adminId = await seedUser({ role: 'owner', email: 'a6@example.com' })
    const token = await seedSession(adminId)

    await SELF.fetch(`http://localhost/api/bills/${billId}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a'] }),
    })

    const res = await SELF.fetch(`http://localhost/api/admin/custom-fields/${fieldId}`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ multiple: false }),
    })
    expect(res.status).toBe(200)
  })

  it('filters bills by multi-select intersection (Match ANY)', async () => {
    const fieldId = await makeMultiField('Tags', ['a', 'b', 'c'])
    const adminId = await seedUser({ role: 'owner', email: 'a7@example.com' })
    const token = await seedSession(adminId)

    const billA = await seedBill({ billNumber: 'H1' })
    const billB = await seedBill({ billNumber: 'H2' })
    const billC = await seedBill({ billNumber: 'H3' })

    await SELF.fetch(`http://localhost/api/bills/${billA}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a', 'b'] }),
    })
    await SELF.fetch(`http://localhost/api/bills/${billB}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['b'] }),
    })
    await SELF.fetch(`http://localhost/api/bills/${billC}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['c'] }),
    })

    // Filter for 'a' → A only
    let res = await SELF.fetch(`http://localhost/api/bills?cf_${fieldId}=a&pageSize=50`, {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    let body = await res.json() as { bills: { id: string }[] }
    expect(body.bills.map(b => b.id).sort()).toEqual([billA].sort())

    // Filter for 'b' → A, B
    res = await SELF.fetch(`http://localhost/api/bills?cf_${fieldId}=b&pageSize=50`, {
      headers: { Cookie: `session=${token}` },
    })
    body = await res.json() as { bills: { id: string }[] }
    expect(body.bills.map(b => b.id).sort()).toEqual([billA, billB].sort())

    // Filter for both 'a' and 'c' (Match ANY) → A, C
    res = await SELF.fetch(`http://localhost/api/bills?cf_${fieldId}=a&cf_${fieldId}=c&pageSize=50`, {
      headers: { Cookie: `session=${token}` },
    })
    body = await res.json() as { bills: { id: string }[] }
    expect(body.bills.map(b => b.id).sort()).toEqual([billA, billC].sort())
  })

  it('facet counts each option of a multi-select field (json_each expansion)', async () => {
    const fieldId = await makeMultiField('Tags', ['a', 'b', 'c'])
    const adminId = await seedUser({ role: 'owner', email: 'facet@example.com' })
    const token = await seedSession(adminId)

    const billA = await seedBill({ billNumber: 'H20' })
    const billB = await seedBill({ billNumber: 'H21' })
    const billC = await seedBill({ billNumber: 'H22' })

    await SELF.fetch(`http://localhost/api/bills/${billA}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a', 'b'] }),
    })
    await SELF.fetch(`http://localhost/api/bills/${billB}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['b'] }),
    })
    await SELF.fetch(`http://localhost/api/bills/${billC}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['c'] }),
    })

    // No active filter → aggregate facet. Each option counted individually.
    const res = await SELF.fetch('http://localhost/api/bills/facets', { headers: { Cookie: `session=${token}` } })
    const body = await res.json() as { customFields: Record<string, Record<string, number>> }
    expect(body.customFields[fieldId]).toEqual({ a: 1, b: 2, c: 1, __any__: 3 })

    // With 'b' active, disjunctive count for the field omits its own filter → unchanged.
    const res2 = await SELF.fetch(`http://localhost/api/bills/facets?cf_${fieldId}=b`, { headers: { Cookie: `session=${token}` } })
    const body2 = await res2.json() as { customFields: Record<string, Record<string, number>> }
    expect(body2.customFields[fieldId]).toEqual({ a: 1, b: 2, c: 1, __any__: 3 })
  })

  it('bulk: additions and removals applied per bill', async () => {
    const fieldId = await makeMultiField('Tags', ['a', 'b', 'c'])
    const adminId = await seedUser({ role: 'owner', email: 'a8@example.com' })
    const token = await seedSession(adminId)

    const billA = await seedBill({ billNumber: 'H10' })
    const billB = await seedBill({ billNumber: 'H11' })

    // Seed initial: A has ['a'], B has ['a','b']
    await SELF.fetch(`http://localhost/api/bills/${billA}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a'] }),
    })
    await SELF.fetch(`http://localhost/api/bills/${billB}/custom-fields`, {
      method: 'PUT', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [fieldId]: ['a', 'b'] }),
    })

    // Bulk: add 'c', remove 'b'
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST', headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [billA, billB],
        customFields: [{ fieldId, additions: ['c'], removals: ['b'] }],
      }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    const aRow = await db.select().from(billCustomFieldValues)
      .where(and(eq(billCustomFieldValues.billId, billA), eq(billCustomFieldValues.fieldId, fieldId))).get()
    const bRow = await db.select().from(billCustomFieldValues)
      .where(and(eq(billCustomFieldValues.billId, billB), eq(billCustomFieldValues.fieldId, fieldId))).get()

    expect(JSON.parse(aRow!.value)).toEqual(['a', 'c'])
    expect(JSON.parse(bRow!.value)).toEqual(['a', 'c'])
  })
})
