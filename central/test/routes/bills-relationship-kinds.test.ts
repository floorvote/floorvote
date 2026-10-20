import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import { clearDb } from '../helpers/migrations'

beforeEach(async () => {
  await clearDb()
})

type Sast = { typeId: number; type: string; number: string; id: number }

// One bill in `state` under `provider`, with the given raw relationships.
async function seedBill(billId: number, state: string, provider: string, sasts: Sast[]) {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({ sessionId: billId, state, stateId: 1, yearStart: 2026, yearEnd: 2027, sessionName: `${state} 2026`, sessionTitle: 'Regular' })
  await db.insert(schema.bills).values({ billId, sessionId: billId, state, stateId: 1, provider, billNumber: `X${billId}`, title: 'A bill', changeHash: 'h', status: 1 })
  for (const s of sasts) {
    await db.insert(schema.billSasts).values({
      id: crypto.randomUUID(), billId, typeId: s.typeId, type: s.type, sastBillNumber: s.number, sastBillId: s.id,
    })
  }
}

async function relatedBills(billId: number) {
  const res = await app.request(`/api/bills/${billId}`, { headers: { 'x-admin-secret': 'test-secret' } }, env)
  expect(res.status).toBe(200)
  return (await res.json() as any).relatedBills as Array<{ identifier: string; relationType: string; kind: string }>
}

const kindsByNumber = (rows: Array<{ identifier: string; kind: string }>) => Object.fromEntries(rows.map(r => [r.identifier, r.kind]))

describe('GET /bills/:id: the kind of each related bill', () => {
  it('serves LegiScan\'s "Same As" and "Crossfiled" as identical', async () => {
    await seedBill(1001, 'NJ', 'legiscan', [{ typeId: 1, type: 'Same As', number: 'S1713', id: 5001 }])
    await seedBill(1002, 'WA', 'legiscan', [{ typeId: 5, type: 'Crossfiled', number: 'SB5001', id: 5002 }])
    expect(await relatedBills(1001)).toEqual([expect.objectContaining({ identifier: 'S1713', kind: 'identical' })])
    expect(await relatedBills(1002)).toEqual([expect.objectContaining({ identifier: 'SB5001', kind: 'identical' })])
  })

  it('keeps the raw label\'s slug as relationType beside the kind', async () => {
    await seedBill(1003, 'NJ', 'legiscan', [{ typeId: 1, type: 'Same As', number: 'S1713', id: 5001 }])
    expect(await relatedBills(1003)).toEqual([expect.objectContaining({ relationType: 'same-as', kind: 'identical' })])
  })

  it('serves Michigan\'s "Same As" as a package, and leaves its other labels on the provider default', async () => {
    await seedBill(1004, 'MI', 'legiscan', [
      { typeId: 1, type: 'Same As', number: 'HB4002', id: 5003 },
      { typeId: 5, type: 'Crossfiled', number: 'SB0007', id: 5004 },
    ])
    expect(kindsByNumber(await relatedBills(1004))).toEqual({ HB4002: 'package', SB0007: 'identical' })
  })

  it('serves a label the vocabulary doesn\'t map as related', async () => {
    await seedBill(1005, 'TX', 'legiscan', [
      { typeId: 2, type: 'Similar To', number: 'SB9', id: 5005 },
      { typeId: 6, type: 'Enabling For', number: 'HJR9', id: 5006 },
      { typeId: 9, type: 'Carry Over', number: 'HB1', id: 5007 },
      { typeId: 99, type: 'A Label Nobody Has Seen', number: 'HB2', id: 5008 },
    ])
    expect(kindsByNumber(await relatedBills(1005))).toEqual({ SB9: 'related', HJR9: 'related', HB1: 'related', HB2: 'related' })
  })

  it('reads the label, never the numeric type id, since ids collide across providers', async () => {
    // type_id 1 is LegiScan's "Same As", and also what Maryland's mapping
    // writes for "Cross-filed". Neither id makes an unmapped label identical.
    await seedBill(1006, 'NJ', 'legiscan', [{ typeId: 1, type: 'Something Else', number: 'S2', id: 5009 }])
    await seedBill(1007, 'MD', 'mga', [{ typeId: 1, type: 'Same As', number: 'SB2', id: 5010 }])
    expect(kindsByNumber(await relatedBills(1006))).toEqual({ S2: 'related' })
    expect(kindsByNumber(await relatedBills(1007))).toEqual({ SB2: 'related' })
  })

  it('serves Maryland\'s "Cross-filed" as identical, from the bill\'s own provider', async () => {
    await seedBill(1008, 'MD', 'mga', [{ typeId: 1, type: 'Cross-filed', number: 'SB2', id: 5011 }])
    expect(await relatedBills(1008)).toEqual([expect.objectContaining({ identifier: 'SB2', relationType: 'cross-filed', kind: 'identical' })])
  })

  it('reads a label without regard to its case', async () => {
    await seedBill(1009, 'NJ', 'legiscan', [{ typeId: 1, type: 'SAME AS', number: 'S3', id: 5012 }])
    expect(kindsByNumber(await relatedBills(1009))).toEqual({ S3: 'identical' })
  })
})
