import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { clearDb, seedUser, seedSession, seedBill, stubFetch } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents, users } from '../../src/db/schema'
import { runDigest } from '../../src/lib/digest'
import { mail, resetMail } from '../mail'

// Each person chooses how often they get the email digest: every morning (users.email_digest_weekly_day null), or once a
// week on a weekday they pick (0 Sunday to 6 Saturday, in UTC). The team sets neither. Each schedule keeps its own window:
// last_digest_at for the daily digest, and last_weekly_digest_at_<day> for each weekday, which starts a week back when it
// has never been sent.

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

const db = () => getDb(env.DB)
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const daysAgo = (d: number) => fmt(Date.now() - d * 86400_000)
const today = () => new Date().getUTCDay()
const otherDay = () => (new Date().getUTCDay() + 3) % 7
const sent = () => mail.sent() as Array<{ to: string[]; subject: string }>
const subjects = (addr: string) => sent().filter(m => m.to[0] === addr).map(m => m.subject)
const stamp = async (key: string) => (await db().select().from(associationConfig).where(eq(associationConfig.key, key)).get())?.value

async function team(settings: Record<string, unknown> = {}) {
  await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': { enabled: true, settings } }) })
}
const weeklyKey = (day: number) => `last_weekly_digest_at_${day}`
async function setStamp(key: string, value: string) {
  await db().insert(associationConfig).values({ key, value }).onConflictDoUpdate({ target: associationConfig.key, set: { value } })
}
// A member who gets priority bills only, every morning (null) or weekly on a weekday.
async function person(email: string, weeklyDay: number | null) {
  const id = await seedUser({ email, role: 'member', emailDigestMatchesEnabled: false })
  await db().update(users).set({ emailDigestWeeklyDay: weeklyDay }).where(eq(users.id, id))
  await seedSession(id)
  return id
}
// A priority bill with one change at the given time.
async function changedBill(billNumber: string, createdAt: string) {
  const billId = await seedBill({ billNumber, state: 'UT', session: '2026', priority: 'high' })
  await db().insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as never, billId, userId: 'system', metadata: JSON.stringify({ position: 'Support' }), createdAt })
}

describe("each person's digest schedule", () => {
  beforeEach(async () => {
    await clearDb()
    resetMail()
    mail.sendBatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, results: [] })
  })

  it("sends a daily person the day, a person weekly on today the week, and a person weekly on another day nothing", async () => {
    await team()
    await setStamp('last_digest_at', daysAgo(1))
    await setStamp(weeklyKey(today()), daysAgo(7))
    await person('daily@example.com', null)
    await person('today@example.com', today())
    await person('other@example.com', otherDay())
    await changedBill('H 1', daysAgo(3))
    await changedBill('H 2', fmt(Date.now() - 3600_000))

    const result = await runDigest(env as never, db())

    expect(result.skipped).toBeUndefined()
    expect(subjects('daily@example.com')).toEqual(['Your daily digest: 1 updated bill'])
    expect(subjects('today@example.com')).toEqual(['Your weekly digest: 2 updated bills'])
    expect(subjects('other@example.com')).toEqual([])
  })

  it("no longer reads the team's how often or weekly day", async () => {
    await team({ frequency: 'weekly', weeklyDay: String(otherDay()) })
    await person('daily@example.com', null)
    await person('today@example.com', today())
    await changedBill('H 1', fmt(Date.now() - 3600_000))

    await runDigest(env as never, db())

    expect(subjects('daily@example.com')).toEqual(['Your daily digest: 1 updated bill'])
    expect(subjects('today@example.com')).toEqual(['Your weekly digest: 1 updated bill'])
  })

  it('gives a weekly digest that was never sent the last seven days', async () => {
    await team()
    await setStamp('last_digest_at', daysAgo(1))
    await person('weekly@example.com', today())
    await changedBill('H 1', daysAgo(6))
    await changedBill('H 2', daysAgo(8))

    await runDigest(env as never, db())

    expect(subjects('weekly@example.com')).toEqual(['Your weekly digest: 1 updated bill'])
  })

  it("stamps the daily window and today's weekly window, and leaves other days' windows alone", async () => {
    await team()
    await person('daily@example.com', null)
    await person('other@example.com', otherDay())

    await runDigest(env as never, db())

    expect(await stamp('last_digest_at')).toBeDefined()
    expect(await stamp(weeklyKey(today()))).toBeDefined()
    expect(await stamp(weeklyKey(otherDay()))).toBeUndefined()
  })

  it('sends everyone on a send-now run, whatever the day', async () => {
    await team()
    await person('daily@example.com', null)
    await person('other@example.com', otherDay())
    await changedBill('H 1', fmt(Date.now() - 3600_000))

    await runDigest(env as never, db(), { ignoreSchedule: true })

    expect(subjects('daily@example.com')).toEqual(['Your daily digest: 1 updated bill'])
    expect(subjects('other@example.com')).toEqual(['Your weekly digest: 1 updated bill'])
  })
})

describe('saving how often', () => {
  // Central's superadmin allowlist is fetched in the background on a first authenticated request; answer it.
  beforeEach(async () => { stubFetch(); await clearDb() })

  const me = async (token: string) =>
    (await SELF.fetch('http://localhost/api/auth/me', { headers: { Cookie: `session=${token}` } })).json() as Promise<{ emailDigestWeeklyDay: number | null }>
  const patchMe = (token: string, body: unknown) => SELF.fetch('http://localhost/api/users/me', {
    method: 'PATCH',
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('starts a person on every morning', async () => {
    const token = await seedSession(await seedUser())
    expect((await me(token)).emailDigestWeeklyDay).toBeNull()
  })

  it('saves a weekday and back to every morning, and echoes each', async () => {
    const token = await seedSession(await seedUser())

    const res = await patchMe(token, { emailDigestWeeklyDay: 5 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ emailDigestWeeklyDay: 5 })
    expect((await me(token)).emailDigestWeeklyDay).toBe(5)

    expect(await (await patchMe(token, { emailDigestWeeklyDay: 0 })).json()).toEqual({ emailDigestWeeklyDay: 0 })
    expect((await me(token)).emailDigestWeeklyDay).toBe(0)

    expect(await (await patchMe(token, { emailDigestWeeklyDay: null })).json()).toEqual({ emailDigestWeeklyDay: null })
    expect((await me(token)).emailDigestWeeklyDay).toBeNull()
  })

  it('ignores a value that is not a weekday from 0 to 6 or null', async () => {
    const token = await seedSession(await seedUser())
    for (const bad of [7, -1, 2.5, '3', 'monday', true]) await patchMe(token, { emailDigestWeeklyDay: bad })
    expect((await me(token)).emailDigestWeeklyDay).toBeNull()
  })
})
