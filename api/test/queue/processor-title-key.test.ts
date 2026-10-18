import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills } from '../../src/db/schema'

// Every delivery of a bill stores the title key and chamber central serves for
// it (#521), on every path the processor takes, including the ones that skip
// an unchanged bill, so opting a state in or out reaches the instance on each
// bill's next delivery, and a metadata refresh reaches every bill at once.

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }
const KEY = 'B|an act relating to elections and the registration of voters'

// What central serves for the bill. Fields left undefined are left out, as an older central leaves them.
let served: { titleKey?: string | null; body?: string | null; updatedAt?: string } = {}

function centralBill(handle: string) {
  return {
    billId: handle,
    sessionId: 'pa:2026',
    state: 'PA',
    number: 'HB100',
    title: 'An act relating to elections and the registration of voters',
    abstract: null,
    status: 'Introduced',
    statusDate: null,
    updatedAt: served.updatedAt ?? '2026-10-01T00:00:00Z',
    stateUrl: null,
    textHash: null,
    textR2Key: null,
    texts: [],
    actions: [],
    sponsors: [],
    votes: [],
    relatedBills: [],
    ...('titleKey' in served ? { titleKey: served.titleKey } : {}),
    ...('body' in served ? { body: served.body } : {}),
  }
}

async function deliver(opts: Record<string, unknown> = { metadataOnly: true }) {
  await processCentralNotification({ tenantId: 'test-org', billId: 'legiscan:100', ...opts }, testEnv as never, getDb(env.DB))
}

async function stored() {
  return await getDb(env.DB).select({ titleKey: bills.titleKey, chamber: bills.chamber }).from(bills).where(eq(bills.id, 'h100')).get()
}

describe('the title key at ingest', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    served = {}
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const handle = decodeURIComponent(String(url).split('/bills/')[1] ?? '')
      return { ok: true, json: async () => centralBill(handle) }
    }))
    await seedBill({ id: 'h100', billNumber: 'HB100', state: 'PA', externalId: 'legiscan:100', providerUpdatedAt: '2026-10-01T00:00:00Z' })
  })

  it('stores the key and chamber central serves', async () => {
    served = { titleKey: KEY, body: 'H' }
    await deliver()
    expect(await stored()).toEqual({ titleKey: KEY, chamber: 'H' })
  })

  it('clears the key when central stops serving one, as when a state is opted out', async () => {
    served = { titleKey: KEY, body: 'H' }
    await deliver()
    expect(await stored()).toEqual({ titleKey: KEY, chamber: 'H' })
    served = { titleKey: null, body: 'H' }
    await deliver()
    expect(await stored()).toEqual({ titleKey: null, chamber: 'H' })
  })

  it('stores no key from an older central that serves none', async () => {
    served = { titleKey: KEY, body: 'H' }
    await deliver()
    expect(await stored()).toEqual({ titleKey: KEY, chamber: 'H' })
    served = {}
    await deliver()
    expect(await stored()).toEqual({ titleKey: null, chamber: null })
  })

  it('stores an empty chamber, as a stub has, as none', async () => {
    served = { titleKey: KEY, body: 'S' }
    await deliver()
    expect(await stored()).toEqual({ titleKey: KEY, chamber: 'S' })
    served = { titleKey: null, body: '' }
    await deliver()
    expect(await stored()).toEqual({ titleKey: null, chamber: null })
  })

  it('stores them on the path that skips an unchanged bill', async () => {
    // Same updatedAt as stored, and no flags: the processor skips the bill as unchanged.
    served = { titleKey: KEY, body: 'H', updatedAt: '2026-10-01T00:00:00Z' }
    await deliver({})
    expect(await stored()).toEqual({ titleKey: KEY, chamber: 'H' })
  })

  it('stores them on a stub-only delivery', async () => {
    served = { titleKey: KEY, body: 'H' }
    await deliver({ stubOnly: true })
    expect(await stored()).toEqual({ titleKey: KEY, chamber: 'H' })
  })

  it('stores them for a bill the delivery creates', async () => {
    served = { titleKey: KEY, body: 'H' }
    await processCentralNotification({ tenantId: 'test-org', billId: 'legiscan:555', stubOnly: true }, testEnv as never, getDb(env.DB))
    const row = await getDb(env.DB).select({ titleKey: bills.titleKey, chamber: bills.chamber }).from(bills).where(eq(bills.externalId, 'legiscan:555')).get()
    expect(row).toEqual({ titleKey: KEY, chamber: 'H' })
  })

  it('writes nothing to the bill when the key and chamber are unchanged', async () => {
    served = { titleKey: KEY, body: 'H' }
    await deliver({})
    const before = await getDb(env.DB).select({ updatedAt: bills.updatedAt }).from(bills).where(eq(bills.id, 'h100')).get()
    const writes: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (/^\s*update\s+"?bills"?/i.test(sql) && /title_key/.test(sql)) writes.push(sql)
      return realPrepare(sql)
    })
    await deliver({})
    spy.mockRestore()
    // One guarded statement, which matches no row when nothing changed.
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/is not/i)
    expect(await getDb(env.DB).select({ updatedAt: bills.updatedAt }).from(bills).where(eq(bills.id, 'h100')).get()).toEqual(before)
  })
})
