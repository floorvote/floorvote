import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { getDb } from '../../src/db/client'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { billCustomFieldValues } from '../../src/db/schema'
import { and, eq } from 'drizzle-orm'

async function adminToken(email: string): Promise<string> {
  const id = await seedUser({ role: 'owner', email })
  return seedSession(id)
}

async function makeDocumentField(token: string, body: Record<string, unknown> = {}): Promise<{ id: string; type: string; multiple: boolean }> {
  const res = await SELF.fetch('http://localhost/api/admin/custom-fields', {
    method: 'POST',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Testimony', type: 'document', ...body }),
  })
  expect(res.status).toBe(201)
  return res.json() as Promise<{ id: string; type: string; multiple: boolean }>
}

function putValues(token: string, billId: string, values: Record<string, unknown>) {
  return SELF.fetch(`http://localhost/api/bills/${billId}/custom-fields`, {
    method: 'PUT',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
}

async function storedValue(billId: string, fieldId: string): Promise<string | undefined> {
  const row = await getDb(env.DB).select().from(billCustomFieldValues)
    .where(and(eq(billCustomFieldValues.billId, billId), eq(billCustomFieldValues.fieldId, fieldId)))
    .get()
  return row?.value
}

describe('document custom fields', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('creates a document field, never multi-select', async () => {
    const token = await adminToken('a1@example.com')
    const field = await makeDocumentField(token, { multiple: true })
    expect(field.type).toBe('document')
    expect(field.multiple).toBe(false)
  })

  it('stores titled https links, trimmed and normalized', async () => {
    const token = await adminToken('a2@example.com')
    const field = await makeDocumentField(token)
    const billId = await seedBill()

    const res = await putValues(token, billId, {
      [field.id]: [
        { title: ' Testimony ', url: 'https://docs.google.com/document/d/abc' },
        { title: 'Comment letter', url: 'https://example.org/letter.pdf' },
      ],
    })
    expect(res.status).toBe(200)
    expect(JSON.parse((await storedValue(billId, field.id))!)).toEqual([
      { title: 'Testimony', url: 'https://docs.google.com/document/d/abc' },
      { title: 'Comment letter', url: 'https://example.org/letter.pdf' },
    ])
  })

  it('returns the stored value on the bill page', async () => {
    const token = await adminToken('a3@example.com')
    const field = await makeDocumentField(token)
    const billId = await seedBill()
    await putValues(token, billId, { [field.id]: [{ title: 'Letter', url: 'https://example.org/l' }] })

    const res = await SELF.fetch(`http://localhost/api/bills/${billId}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    const bill = await res.json() as { customFieldValues: Record<string, { value: string }> }
    expect(JSON.parse(bill.customFieldValues[field.id].value)).toEqual([{ title: 'Letter', url: 'https://example.org/l' }])
  })

  it.each([
    ['an http link', [{ title: 'Letter', url: 'http://example.org/l' }]],
    ['a javascript link', [{ title: 'Letter', url: 'javascript:alert(1)' }]],
    ['a missing title', [{ url: 'https://example.org/l' }]],
    ['a bare string', 'https://example.org/l'],
    ['a list of strings', ['https://example.org/l']],
  ])('refuses %s', async (_label, value) => {
    const token = await adminToken('a4@example.com')
    const field = await makeDocumentField(token)
    const billId = await seedBill()

    const res = await putValues(token, billId, { [field.id]: value })
    expect(res.status).toBe(400)
    expect(await storedValue(billId, field.id)).toBeUndefined()
  })

  it('refuses more than 20 documents', async () => {
    const token = await adminToken('a5@example.com')
    const field = await makeDocumentField(token)
    const billId = await seedBill()
    const docs = Array.from({ length: 21 }, (_, i) => ({ title: `Doc ${i}`, url: `https://example.org/${i}` }))

    const res = await putValues(token, billId, { [field.id]: docs })
    expect(res.status).toBe(400)
  })

  it('clears the field with an empty list', async () => {
    const token = await adminToken('a6@example.com')
    const field = await makeDocumentField(token)
    const billId = await seedBill()
    await putValues(token, billId, { [field.id]: [{ title: 'Letter', url: 'https://example.org/l' }] })

    const res = await putValues(token, billId, { [field.id]: [] })
    expect(res.status).toBe(200)
    expect(await storedValue(billId, field.id)).toBeUndefined()
  })

  it('cannot be bulk edited', async () => {
    const token = await adminToken('a7@example.com')
    const field = await makeDocumentField(token)
    const billId = await seedBill()

    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId], customFields: [{ fieldId: field.id, value: '[{"title":"x","url":"javascript:alert(1)"}]' }] }),
    })
    expect(res.status).toBe(400)
    expect(await storedValue(billId, field.id)).toBeUndefined()
  })
})
