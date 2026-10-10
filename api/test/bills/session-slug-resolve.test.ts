import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills } from '../../src/db/schema'

// Central assigns each session a slug unique within its state and sends it
// with each bill. Two providers' Maryland "2026 Regular Session" ask for the
// same slug ("2026"), so central gives the later one "2026-2".

const MD_2026 = '2026 Regular Session'

describe('bill URLs by the session slug central assigned', () => {
  let cookie: string
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    cookie = `session=${await seedSession(await seedUser({ email: 'm@x.com' }))}`
  })
  afterEach(() => vi.unstubAllGlobals())

  const resolve = (path: string) => SELF.fetch(`https://x/api/bills/resolve/${path}`, { headers: { Cookie: cookie } })
  const idAt = async (path: string) => {
    const res = await resolve(path)
    expect(res.status).toBe(200)
    return ((await res.json()) as { id: string }).id
  }

  const centralBill = (sessionSlug: string | null) => ({
    billId: 'legiscan:3000000101', sessionId: '3000000005', sessionName: MD_2026, sessionSlug,
    yearStart: 2026, yearEnd: 2026, state: 'MD', number: 'HB1', title: 'MGA HB 1', abstract: null,
    status: 'Introduced', statusDate: null, updatedAt: '2026-01-10', stateUrl: null, textHash: null, textR2Key: null,
    texts: [], actions: [], sponsors: [], votes: [], relatedBills: [],
  })
  const notify = async (sessionSlug: string | null) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => centralBill(sessionSlug) }))
    await processCentralNotification({ tenantId: 'test-tenant', billId: 'legiscan:3000000101', stubOnly: true },
      { ...env, TENANT_ID: 'test-tenant', CENTRAL_API_URL: 'https://central.test' } as any, getDb(env.DB))
    vi.unstubAllGlobals()
  }
  const storedSlugs = () => getDb(env.DB).select({ id: bills.id, sessionSlug: bills.sessionSlug }).from(bills).all()

  it('stores the slug central sends, and serves and resolves the bill by it', async () => {
    await notify('2026-2')
    const stored = await storedSlugs()
    expect(stored).toEqual([{ id: expect.any(String), sessionSlug: '2026-2' }])
    const detail = await (await resolve('MD/2026-2/HB1')).json() as { id: string; sessionSlug: string }
    expect(detail).toMatchObject({ id: stored[0].id, sessionSlug: '2026-2' })
  })

  it('keeps a stored slug when central later sends none', async () => {
    await notify('2026-2')
    await notify(null)
    expect(await storedSlugs()).toEqual([{ id: expect.any(String), sessionSlug: '2026-2' }])
  })

  it('tells apart same-number bills in two sessions with the same name', async () => {
    const legiscan = await seedBill({ billNumber: 'HB1', state: 'MD', session: MD_2026, sessionSlug: '2026', externalId: 'legiscan:9001' })
    const mga = await seedBill({ billNumber: 'HB1', state: 'MD', session: MD_2026, sessionSlug: '2026-2', externalId: 'legiscan:3000000101' })
    expect(await idAt('MD/2026/HB1')).toBe(legiscan)
    expect(await idAt('MD/2026-2/HB1')).toBe(mga)

    const list = await (await SELF.fetch('https://x/api/bills', { headers: { Cookie: cookie } })).json() as { bills: { id: string; sessionSlug: string }[] }
    expect(Object.fromEntries(list.bills.map(b => [b.id, b.sessionSlug]))).toEqual({ [legiscan]: '2026', [mga]: '2026-2' })
  })

  it('keeps a link made with the slug the session name asks for working, where only one bill answers to it', async () => {
    const mga = await seedBill({ billNumber: 'HB1', state: 'MD', session: MD_2026, sessionSlug: '2026-2', externalId: 'legiscan:3000000101' })
    expect(await idAt('MD/2026/HB1')).toBe(mga)
    expect(await idAt('2026/HB1')).toBe(mga)
  })

  it("prefers a bill whose stored slug matches over an old link through another bill's computed slug", async () => {
    // The old link /MD/2026/HB1 meant the MGA bill while it was the only HB 1.
    // Once a bill answers to "2026" by its stored slug, the link means that bill.
    const mga = await seedBill({ billNumber: 'HB1', state: 'MD', session: MD_2026, sessionSlug: '2026-2', externalId: 'legiscan:3000000101' })
    expect(await idAt('MD/2026/HB1')).toBe(mga)
    const legiscan = await seedBill({ billNumber: 'HB1', state: 'MD', session: MD_2026, sessionSlug: '2026', externalId: 'legiscan:9001' })
    expect(await idAt('MD/2026/HB1')).toBe(legiscan)
  })

  it('computes the slug, as before, for a bill stored before central sent one', async () => {
    const old = await seedBill({ billNumber: 'HB1', state: 'MD', session: MD_2026, externalId: 'legiscan:9001' })
    expect(await idAt('MD/2026/HB1')).toBe(old)
    const detail = await (await resolve('MD/2026/HB1')).json() as { sessionSlug: string }
    expect(detail.sessionSlug).toBe('2026')
  })
})
