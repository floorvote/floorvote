import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, applyMigrations, appFetch, stubFetch, seedUser, seedSession, seedBill } from '../helpers'

// Releases before provider-model slugged a numbered special session to its
// year: "2026 Special Session 1" was /MD/2026/..., and is /MD/2026-s1/... now.
// Links in old digests, emails, and bookmarks still say /MD/2026/....

const REGULAR = '2026 Regular Session'
const SPECIAL_1 = '2026 Special Session 1'
const SPECIAL_2 = '2026 Special Session 2'

describe('resolving a link made before a session got its own slug', () => {
  let cookie: string
  beforeEach(async () => {
    stubFetch() // the bill lookup may ask central in the background; answer it, never reach it
    await resetDb()
    await applyMigrations()
    cookie = `session=${await seedSession(await seedUser({ email: 'm@x.com' }))}`
  })
  const get = (path: string) => appFetch(`https://x/api/bills/resolve/${path}`, { headers: { Cookie: cookie } })
  const ok = async (path: string) => {
    const res = await get(path)
    expect(res.status).toBe(200)
    return await res.json() as { id: string; otherSessionMatches?: unknown }
  }

  it('reaches a special-session bill by its old slug when it is the only one there', async () => {
    // Stored before central sent slugs, and after.
    const legacy = await seedBill({ billNumber: 'HB5', state: 'MD', session: SPECIAL_1, externalId: 'legiscan:5001' })
    const sent = await seedBill({ billNumber: 'HB6', state: 'MD', session: SPECIAL_1, sessionSlug: '2026-s1', externalId: 'legiscan:5002' })
    expect((await ok('MD/2026/HB5')).id).toBe(legacy)
    expect((await ok('MD/2026-s1/HB5')).id).toBe(legacy)
    expect((await ok('2026/HB5')).id).toBe(legacy)
    expect((await ok('MD/2026/HB6')).id).toBe(sent)
    expect((await ok('MD/2026-s1/HB6')).id).toBe(sent)
  })

  it("reaches a Virginia special session's bill by its old slug", async () => {
    const va = await seedBill({ billNumber: 'HB5', state: 'VA', session: '2026 Special Session I', sessionSlug: '2026-s1', externalId: 'legiscan:5003' })
    expect((await ok('VA/2026/HB5')).id).toBe(va)
  })

  it("keeps a regular session's URL its own, and names the special-session bill an old link may have meant", async () => {
    const regular = await seedBill({ billNumber: 'HB5', state: 'MD', session: REGULAR, sessionSlug: '2026', externalId: 'legiscan:5004' })
    const special = await seedBill({ billNumber: 'HB5', state: 'MD', session: SPECIAL_1, sessionSlug: '2026-s1', externalId: 'legiscan:5005' })
    const atOld = await ok('MD/2026/HB5')
    expect(atOld.id).toBe(regular)
    expect(atOld.otherSessionMatches).toEqual([{ state: 'MD', sessionSlug: '2026-s1', session: SPECIAL_1, billNumber: 'HB5' }])
    const atNew = await ok('MD/2026-s1/HB5')
    expect(atNew.id).toBe(special)
    expect(atNew.otherSessionMatches).toBeUndefined()
  })

  it('names the bill of a session that lost its old slug to a collision', async () => {
    // "2026 Special Session" (no number) slugged to "2026" before and still
    // asks for it, but the regular session holds it, so central gave it "2026-2".
    const regular = await seedBill({ billNumber: 'HB5', state: 'MD', session: REGULAR, sessionSlug: '2026', externalId: 'legiscan:5004' })
    await seedBill({ billNumber: 'HB5', state: 'MD', session: '2026 Special Session', sessionSlug: '2026-2', externalId: 'legiscan:5008' })
    const atOld = await ok('MD/2026/HB5')
    expect(atOld.id).toBe(regular)
    expect(atOld.otherSessionMatches).toEqual([{ state: 'MD', sessionSlug: '2026-2', session: '2026 Special Session', billNumber: 'HB5' }])
  })

  it('refuses to guess when a link without a state matches a bill another state holds by an old slug', async () => {
    // /2026/HB5 is VA's regular-session HB5 today, and was MD's special-session
    // HB5 too. The page would redirect to /VA/2026/HB5, where MD's bill isn't a
    // candidate, so a note there would vanish: name both instead, as main did.
    await seedBill({ billNumber: 'HB5', state: 'VA', session: REGULAR, sessionSlug: '2026', externalId: 'legiscan:5009' })
    await seedBill({ billNumber: 'HB5', state: 'MD', session: SPECIAL_1, sessionSlug: '2026-s1', externalId: 'legiscan:5005' })
    const res = await get('2026/HB5')
    expect(res.status).toBe(409)
    const body = await res.json() as { candidates: unknown[] }
    expect(body.candidates).toEqual([
      { state: 'VA', sessionSlug: '2026', session: REGULAR, billNumber: 'HB5' },
      { state: 'MD', sessionSlug: '2026-s1', session: SPECIAL_1, billNumber: 'HB5' },
    ])
    // With the state, VA's bill is the only candidate.
    expect((await ok('VA/2026/HB5')).otherSessionMatches).toBeUndefined()
  })

  it('sends no other matches for an ordinary link', async () => {
    await seedBill({ billNumber: 'HB5', state: 'MD', session: REGULAR, sessionSlug: '2026', externalId: 'legiscan:5004' })
    expect((await ok('MD/2026/HB5')).otherSessionMatches).toBeUndefined()
  })

  it('refuses to guess when an old link matches bills in two special sessions, and names both', async () => {
    await seedBill({ billNumber: 'HB5', state: 'MD', session: SPECIAL_1, sessionSlug: '2026-s1', externalId: 'legiscan:5005' })
    await seedBill({ billNumber: 'HB5', state: 'MD', session: SPECIAL_2, sessionSlug: '2026-s2', externalId: 'legiscan:5006' })
    const res = await get('MD/2026/HB5')
    expect(res.status).toBe(409)
    const body = await res.json() as { candidates: unknown[] }
    expect(body.candidates).toHaveLength(2)
    expect(body.candidates).toEqual(expect.arrayContaining([
      { state: 'MD', sessionSlug: '2026-s1', session: SPECIAL_1, billNumber: 'HB5' },
      { state: 'MD', sessionSlug: '2026-s2', session: SPECIAL_2, billNumber: 'HB5' },
    ]))
  })

  it('refuses to guess when an old link matches a special session and a regular session that central renamed', async () => {
    // Two providers' regular sessions: the other one holds "2026", so this
    // one is "2026-2". An old /MD/2026/HB5 could mean it or the special session.
    await seedBill({ billNumber: 'HB5', state: 'MD', session: REGULAR, sessionSlug: '2026-2', externalId: 'legiscan:5007' })
    await seedBill({ billNumber: 'HB5', state: 'MD', session: SPECIAL_1, sessionSlug: '2026-s1', externalId: 'legiscan:5005' })
    expect((await get('MD/2026/HB5')).status).toBe(409)
  })

  it('keeps LegiScan DC links working once a Council Period has its own slug', async () => {
    const dc = await seedBill({ billNumber: 'B26-0400', state: 'DC', session: '2025-2026 Council Period 26', sessionSlug: 'cp26', externalId: 'legiscan:2000400' })
    expect((await ok('DC/2025-2026/B26-0400')).id).toBe(dc)
    expect((await ok('DC/cp26/B26-0400')).id).toBe(dc)
    expect((await ok('2025-2026/B26-0400')).id).toBe(dc)
  })
})
