import { describe, it, expect, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { clearDb, stubFetch, seedUser, seedSession } from '../helpers'

// #366: the option nested under the digest switch, "Include newly matched bills".
describe('the digest new-match option', () => {
  beforeEach(async () => {
    await clearDb()
    // /auth/me and PATCH /users/me look up central's superadmin allowlist, and the
    // network guard refuses a fetch no test stubbed. An empty allowlist: nobody here is a superadmin.
    stubFetch(url => (new URL(url).pathname === '/api/admin/superadmin/emails'
      ? new Response(JSON.stringify({ hashes: [] }), { status: 200 })
      : new Response('not found', { status: 404 })))
  })

  const patchMe = (token: string, body: unknown) => SELF.fetch('http://localhost/api/users/me', {
    method: 'PATCH',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const me = async (token: string) =>
    (await SELF.fetch('http://localhost/api/auth/me', { headers: { Cookie: `session=${token}` } })).json() as Promise<Record<string, unknown>>

  it('is on by default', async () => {
    const token = await seedSession(await seedUser())
    expect((await me(token)).emailDigestMatchesEnabled).toBe(true)
  })

  it('turns off and back on through PATCH /users/me, echoed and read back by /auth/me', async () => {
    const token = await seedSession(await seedUser())
    const off = await patchMe(token, { emailDigestMatchesEnabled: false })
    expect(off.status).toBe(200)
    expect(await off.json()).toEqual({ emailDigestMatchesEnabled: false })
    expect((await me(token)).emailDigestMatchesEnabled).toBe(false)
    await patchMe(token, { emailDigestMatchesEnabled: true })
    expect((await me(token)).emailDigestMatchesEnabled).toBe(true)
  })

  it('leaves the digest switch alone, and the switch leaves the option alone', async () => {
    const token = await seedSession(await seedUser())
    await patchMe(token, { emailDigestMatchesEnabled: false })
    expect(await me(token)).toMatchObject({ emailDigestEnabled: true, emailDigestMatchesEnabled: false })
    await patchMe(token, { emailDigestEnabled: false })
    expect(await me(token)).toMatchObject({ emailDigestEnabled: false, emailDigestMatchesEnabled: false })
  })

  it('reads and saves how often the digest comes: every morning by default, or a weekday from 0 to 6', async () => {
    const token = await seedSession(await seedUser())
    expect((await me(token)).emailDigestWeeklyDay).toBeNull()
    const res = await patchMe(token, { emailDigestWeeklyDay: 4 })
    expect(await res.json()).toEqual({ emailDigestWeeklyDay: 4 })
    expect((await me(token)).emailDigestWeeklyDay).toBe(4)
    await patchMe(token, { emailDigestWeeklyDay: null })
    expect((await me(token)).emailDigestWeeklyDay).toBeNull()
  })

  it.each([7, -1, 2.5, '3'])('ignores %j as the digest day', async (day) => {
    const token = await seedSession(await seedUser())
    await patchMe(token, { emailDigestWeeklyDay: 2 })
    await patchMe(token, { emailDigestWeeklyDay: day })
    expect((await me(token)).emailDigestWeeklyDay).toBe(2)
  })
})
