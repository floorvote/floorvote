import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import migration0001 from '../../migrations/0001_initial.sql?raw'
import migration0003 from '../../migrations/0003_openstates_migration.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map((s) =>
      s.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim(),
    )
    .filter((s) => s.length > 0)
    .map((s) => s + ';')
  return { name, queries }
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0003, '0003_openstates_migration'),
  ])
})

async function insertBill(billId: string, textR2Key?: string) {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({
    sessionId: 'ri:2026', state: 'RI', identifier: '2026',
    yearStart: 2026, yearEnd: 2026, sessionName: '2026 Session',
    isCurrent: false, sineDie: true,
  })
  await db.insert(schema.bills).values({
    billId, sessionId: 'ri:2026', state: 'RI',
    number: 'HB 7354', title: 'Election Reform Act',
    textR2Key: textR2Key ?? null,
  })
}

describe('PUT /admin/bills/:id/seed-text', () => {
  it('stores text in R2 and updates textR2Key', async () => {
    const billId = 'ocd-bill/9bad99b0-0f6a-4ead-bf04-c6f10124b7df'
    await insertBill(billId)

    const res = await app.request(
      `/admin/bills/${billId}/seed-text`,
      {
        method: 'PUT',
        body: 'SECTION 1. This is the bill text.',
        headers: { 'x-admin-secret': 'test-secret', 'content-type': 'text/plain' },
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.r2Key).toBe('bills/9bad99b0-0f6a-4ead-bf04-c6f10124b7df/seed.txt')

    const db = drizzle(env.DB, { schema })
    const updated = await db.select({ textR2Key: schema.bills.textR2Key })
      .from(schema.bills)
      .where(eq(schema.bills.billId, billId))
      .get()
    expect(updated?.textR2Key).toBe('bills/9bad99b0-0f6a-4ead-bf04-c6f10124b7df/seed.txt')

    const obj = await env.BILLS_BUCKET.get('bills/9bad99b0-0f6a-4ead-bf04-c6f10124b7df/seed.txt')
    expect(await obj?.text()).toBe('SECTION 1. This is the bill text.')
  })

  it('skips upload if textR2Key already set', async () => {
    const billId = 'ocd-bill/9bad99b0-0f6a-4ead-bf04-c6f10124b7df'
    const existing = 'bills/9bad99b0-0f6a-4ead-bf04-c6f10124b7df/ver-1.html'
    await insertBill(billId, existing)

    const res = await app.request(
      `/admin/bills/${billId}/seed-text`,
      {
        method: 'PUT',
        body: 'SECTION 1. Some text.',
        headers: { 'x-admin-secret': 'test-secret', 'content-type': 'text/plain' },
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.skipped).toBe(true)

    const db = drizzle(env.DB, { schema })
    const updated = await db.select({ textR2Key: schema.bills.textR2Key })
      .from(schema.bills)
      .where(eq(schema.bills.billId, billId))
      .get()
    expect(updated?.textR2Key).toBe(existing)
  })

  it('returns 404 if bill not found', async () => {
    const res = await app.request(
      '/admin/bills/ocd-bill/does-not-exist/seed-text',
      {
        method: 'PUT',
        body: 'some text',
        headers: { 'x-admin-secret': 'test-secret', 'content-type': 'text/plain' },
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('returns 401 without admin secret', async () => {
    const res = await app.request(
      '/admin/bills/ocd-bill/any/seed-text',
      { method: 'PUT', body: 'text' },
      env,
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 for empty body', async () => {
    const billId = 'ocd-bill/9bad99b0-0f6a-4ead-bf04-c6f10124b7df'
    await insertBill(billId)

    const res = await app.request(
      `/admin/bills/${billId}/seed-text`,
      {
        method: 'PUT',
        body: '',
        headers: { 'x-admin-secret': 'test-secret', 'content-type': 'text/plain' },
      },
      env,
    )
    expect(res.status).toBe(400)

    const db = drizzle(env.DB, { schema })
    const bill = await db.select({ textR2Key: schema.bills.textR2Key })
      .from(schema.bills)
      .where(eq(schema.bills.billId, billId))
      .get()
    expect(bill?.textR2Key).toBeNull()
  })
})
