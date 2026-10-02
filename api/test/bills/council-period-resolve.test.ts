import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { sessionToSlug, legacySessionSlug, billUrl } from '../../../shared/sessionSlug'

describe('Council Period slugs', () => {
  it('gives a Council Period its own slug, and remembers the old one', () => {
    expect(sessionToSlug('2025-2026 Council Period 26')).toBe('cp26')
    expect(legacySessionSlug('2025-2026 Council Period 26')).toBe('2025-2026')
    expect(sessionToSlug('2025-2026 Regular Session')).toBe('2025-2026')
    expect(legacySessionSlug('2025-2026 Regular Session')).toBeNull()
    expect(billUrl({ state: 'DC', session: '2025-2026 Council Period 26', billNumber: 'B26-0400' })).toBe('/DC/cp26/B26-0400')
  })
})

describe('resolving DC bill URLs', () => {
  let cookie: string
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    cookie = `session=${await seedSession(await seedUser({ email: 'm@x.com' }))}`
  })
  const get = (path: string) => SELF.fetch(`https://x/api/bills/resolve/${path}`, { headers: { Cookie: cookie } })

  it('tells a Council Period bill from a same-number bill in another 2025-2026 DC session', async () => {
    const lims = await seedBill({ billNumber: 'B26-0400', state: 'DC', session: '2025-2026 Council Period 26', externalId: 'legiscan:1012600400' })
    const other = await seedBill({ billNumber: 'B26-0400', state: 'DC', session: '2025-2026 Regular Session', externalId: 'legiscan:2000001' })
    expect(((await (await get('DC/cp26/B26-0400')).json()) as any).id).toBe(lims)
    expect(((await (await get('DC/2025-2026/B26-0400')).json()) as any).id).toBe(other)
  })

  it('keeps old /DC/2025-2026/ links working when they are unambiguous', async () => {
    const lims = await seedBill({ billNumber: 'B26-0400', state: 'DC', session: '2025-2026 Council Period 26', externalId: 'legiscan:1012600400' })
    expect(((await (await get('DC/2025-2026/B26-0400')).json()) as any).id).toBe(lims)
    expect(((await (await get('2025-2026/B26-0400')).json()) as any).id).toBe(lims)
  })

  it('refuses to guess when an old link matches two Council Periods', async () => {
    await seedBill({ billNumber: 'B26-0400', state: 'DC', session: '2025-2026 Council Period 26', externalId: 'legiscan:1012600400' })
    await seedBill({ billNumber: 'B26-0400', state: 'DC', session: '2025-2026 Council Period 27', externalId: 'legiscan:1012700400' })
    expect((await get('DC/2025-2026/B26-0400')).status).toBe(409)
  })
})
