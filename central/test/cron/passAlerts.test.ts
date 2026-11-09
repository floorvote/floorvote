import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { sessions, sessionSyncLog, settings } from '../../src/db/schema'

// A failing session alerts once its streak of failed passes has lasted four
// hours, then at most once every four hours while it goes on, read from the
// failed rows in session_sync_log. A session that pulls hourly alerts at about
// 4, 8, and 12 hours; one that pulls daily alerts on its second failed pass.
vi.mock('../../src/lib/jobAlert', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/jobAlert')>('../../src/lib/jobAlert')
  return { ...actual, sendOpsAlert: vi.fn().mockResolvedValue(undefined) }
})

import { streakAlerts, recoveryFrom, sendRecoveries, warmEnded, forgetWarmStreaks, type SessionFailure } from '../../src/cron/passAlerts'
import { sendOpsAlert, jobThreadHeaders } from '../../src/lib/jobAlert'
import { joinAlertThread } from '../../src/lib/alertThread'
import { clearDb } from '../helpers/migrations'
import { toDb } from '../../src/lib/dbTime'

const db = () => drizzle(env.DB, { schema })
const T0 = Date.parse('2026-10-20T00:00:00Z')
const H = 3_600_000
const at = (hours: number) => toDb(new Date(T0 + hours * H))

const NJ = { sessionId: 8001, state: 'NJ', sessionName: '2026-2027 Regular Session' }
const US = { sessionId: 8002, state: 'US', sessionName: '119th Congress' }
const JOB = { job: 'ls-sync', providerId: 'legiscan', name: 'LegiScan' }

async function seedSession(s: typeof NJ, lastSyncedAt: string | null = null) {
  await db().insert(sessions).values({
    sessionId: s.sessionId, state: s.state, stateId: 1, yearStart: 2026, yearEnd: 2027,
    sessionTitle: s.sessionName, sessionName: s.sessionName, lastSyncedAt,
  })
}
async function logRow(s: typeof NJ, hours: number, status: 'ok' | 'failed') {
  await db().insert(sessionSyncLog).values({
    syncedAt: at(hours), state: s.state, sessionId: s.sessionId, sessionName: s.sessionName, status,
    error: status === 'failed' ? 'boom' : null,
  })
}
const failure = (s: typeof NJ, lastSyncedAt: string | null = null): SessionFailure =>
  ({ session: { ...s, lastSyncedAt }, error: new Error('boom'), logged: true })

/** The 1-based failed passes, run `offsets` hours after the first, that raise an alert. */
async function alertingPasses(offsets: number[], lastSyncedAt: string | null = null): Promise<number[]> {
  await seedSession(NJ, lastSyncedAt)
  const alerted: number[] = []
  for (const [i, h] of offsets.entries()) {
    await logRow(NJ, h, 'failed')
    if ((await streakAlerts(db(), 'test', [failure(NJ, lastSyncedAt)])).length > 0) alerted.push(i + 1)
  }
  return alerted
}
const hourly = (n: number, start = 0) => Array.from({ length: n }, (_, i) => start + i)

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())

describe('when a failing session alerts', () => {
  it('alerts an hourly session at about 4, 8, and 12 hours into the streak', async () => {
    // Failed passes at hours 0..12: the 5th, 9th, and 13th.
    expect(await alertingPasses(hourly(13))).toEqual([5, 9, 13])
  })

  it('stays quiet before the streak has lasted 4 hours', async () => {
    expect(await alertingPasses(hourly(4))).toEqual([])
  })

  it('alerts a daily session on its 2nd failed pass, then on each later one', async () => {
    expect(await alertingPasses([0, 24, 48, 72])).toEqual([2, 3, 4])
  })

  it('stays quiet on a daily session\'s first failed pass', async () => {
    expect(await alertingPasses([0])).toEqual([])
  })

  it('alerts a session that pulls every 6 hours on each pass after the first, since each is 4 or more hours on', async () => {
    expect(await alertingPasses([0, 6, 12, 18])).toEqual([2, 3, 4])
  })

  it('alerts a session that pulls every 3 hours at 6, 12, and 18 hours', async () => {
    expect(await alertingPasses([0, 3, 6, 9, 12, 15, 18])).toEqual([3, 5, 7])
  })

  it('treats a pass a few minutes early as on time, so cron jitter does not push the alert an hour on', async () => {
    const jitter = [0, 1, 2, 3, 4 - 2 / 60, 5, 6, 7, 8 - 3 / 60]
    expect(await alertingPasses(jitter)).toEqual([5, 9])
  })

  it('alerts once when a streak\'s passes were skipped for hours and the next one lands past two marks', async () => {
    // Failed at hour 0, then nothing until hour 9: one alert, not two.
    expect(await alertingPasses([0, 9])).toEqual([2])
  })

  it('counts only the failed passes since the last finished one', async () => {
    // Synced at hour 20; failed passes from hour 21 on are a new streak: first alert at hour 25.
    const synced = at(20)
    await seedSession(NJ, synced)
    await logRow(NJ, 0, 'failed')
    await logRow(NJ, 19, 'failed')
    await logRow(NJ, 20, 'ok')
    const alerted: number[] = []
    for (const [i, h] of hourly(6, 21).entries()) {
      await logRow(NJ, h, 'failed')
      if ((await streakAlerts(db(), 'test', [failure(NJ, synced)])).length > 0) alerted.push(i + 1)
    }
    expect(alerted).toEqual([5])
  })

  it('restarts the clock after a flap: a failure, a success, then a fresh streak', async () => {
    // Fail 0-3 (quiet), succeed at 4, fail 5-8 (a new streak at 5, so quiet at 8), alert at 9.
    const synced = at(4)
    await seedSession(NJ, synced)
    for (const h of [0, 1, 2, 3]) await logRow(NJ, h, 'failed')
    await logRow(NJ, 4, 'ok')
    const alerted: number[] = []
    for (const [i, h] of [5, 6, 7, 8, 9].entries()) {
      await logRow(NJ, h, 'failed')
      if ((await streakAlerts(db(), 'test', [failure(NJ, synced)])).length > 0) alerted.push(i + 1)
    }
    expect(alerted).toEqual([5])
  })

  it('names the session, how long it has failed, the passes, and the error', async () => {
    await seedSession(NJ)
    for (const h of hourly(5)) await logRow(NJ, h, 'failed')
    const [alert] = await streakAlerts(db(), 'test', [failure(NJ)])
    expect(alert.message).toContain(`NJ ${NJ.sessionName}`)
    expect(alert.message).toContain('4 hours')
    expect(alert.message).toContain('5 passes in a row failed')
    expect(alert.message).toContain('boom')
  })

  it('alerts at once for a failed pass that could not be logged', async () => {
    await seedSession(NJ)
    const alerts = await streakAlerts(db(), 'test', [{ ...failure(NJ), logged: false }])
    expect(alerts).toHaveLength(1)
  })
})

describe('whether a finished pass ended a streak that alerted', () => {
  it('is a recovery once the streak lasted 4 hours', async () => {
    await seedSession(NJ)
    for (const h of hourly(5)) await logRow(NJ, h, 'failed')
    expect(await recoveryFrom(db(), { ...NJ, lastSyncedAt: null })).toMatchObject({ failed: 5, since: at(0) })
  })

  it('is none for a streak shorter than that', async () => {
    await seedSession(NJ)
    for (const h of hourly(4)) await logRow(NJ, h, 'failed')
    expect(await recoveryFrom(db(), { ...NJ, lastSyncedAt: null })).toBeNull()
  })

  it('is a recovery for a daily session that failed twice, and none for one failure', async () => {
    await seedSession(NJ)
    await logRow(NJ, 0, 'failed')
    expect(await recoveryFrom(db(), { ...NJ, lastSyncedAt: null })).toBeNull()
    await logRow(NJ, 24, 'failed')
    expect(await recoveryFrom(db(), { ...NJ, lastSyncedAt: null })).not.toBeNull()
  })
})

describe('the email when sessions recover', () => {
  const sent = () => vi.mocked(sendOpsAlert).mock.calls.map(c => c[1])

  it('names the recovered session and does not say the job is syncing again', async () => {
    await seedSession(NJ)
    const rec = { session: { ...NJ, lastSyncedAt: null }, failed: 5, hours: 4, since: at(0) }
    await sendRecoveries(env as any, db(), JOB, [rec])
    const [mail] = sent()
    expect(mail.subject).toContain('resolved: ls-sync')
    expect(mail.text).toContain(`NJ ${NJ.sessionName}`)
    expect(mail.text).toContain('LegiScan')
    expect(mail.text).not.toMatch(/is syncing again/)
    expect(mail.text).not.toContain('still failing')
  })

  it('lists the other sessions in the job that are still failing', async () => {
    await seedSession(NJ)
    await seedSession(US)
    // US failed a pass an hour ago and has not synced since; NJ just recovered.
    await logRow(US, 0, 'failed')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + 2 * H)
    try {
      const rec = { session: { ...NJ, lastSyncedAt: null }, failed: 5, hours: 4, since: at(0) }
      await sendRecoveries(env as any, db(), JOB, [rec])
    } finally { vi.useRealTimers() }
    const [mail] = sent()
    expect(mail.text).toMatch(/still failing:[\s\S]*US 119th Congress/i)
    expect(mail.text.split(/still failing/i)[0]).not.toContain('US 119th Congress')
    expect(mail.html).toContain('119th Congress')
    expect(mail.text).not.toMatch(/is syncing again/)
  })

  it('does not list a session that recovered, or one that failed once and synced since', async () => {
    await seedSession(NJ, at(2))
    await seedSession(US, at(2))
    await logRow(US, 0, 'failed')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + 3 * H)
    try {
      const rec = { session: { ...NJ, lastSyncedAt: null }, failed: 5, hours: 4, since: at(0) }
      await sendRecoveries(env as any, db(), JOB, [rec])
    } finally { vi.useRealTimers() }
    expect(sent()[0].text).not.toMatch(/still failing/i)
  })

  it('does not list a failing session from another provider\'s job', async () => {
    await seedSession(NJ)
    await seedSession(US)
    await env.DB.exec(`UPDATE sessions SET provider = 'lims' WHERE session_id = ${US.sessionId}`)
    await logRow(US, 0, 'failed')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + 2 * H)
    try {
      await sendRecoveries(env as any, db(), JOB, [{ session: { ...NJ, lastSyncedAt: null }, failed: 5, hours: 4, since: at(0) }])
    } finally { vi.useRealTimers() }
    expect(sent()[0].text).not.toMatch(/still failing/i)
  })

  it('sends nothing for no recoveries', async () => {
    await sendRecoveries(env as any, db(), JOB, [])
    expect(sent()).toHaveLength(0)
  })
})

describe("the resolved email's conversation", () => {
  // A resolved email joins the conversation its job's failure alerts opened.
  // When nothing in the job is still failing it also ends that conversation,
  // so the job's next failure starts a new one. Whether anything is still
  // failing is read after the email has gone out, so a failed read can never
  // stop the email: it only leaves the conversation open.
  const sent = () => vi.mocked(sendOpsAlert).mock.calls.map(c => c[1])
  const rec = { session: { ...NJ, lastSyncedAt: null }, failed: 5, hours: 4, since: at(0) }
  const later = () => Date.now() + 60_000
  /** When the conversation an alert sent now (or at `now`) joins started. */
  const startOf = async (job: string, now?: number) => (await joinAlertThread(db(), job, now)).startedAt
  const overloaded = () => new Error('D1_ERROR: D1 DB is overloaded.')
  /** Real D1, except that one kind of read fails as an overloaded D1 does. */
  const failingRead = (method: 'select' | 'selectDistinct', fields: string) => {
    const real = db()
    return new Proxy(real, {
      get(target, prop) {
        if (prop !== method) return Reflect.get(target, prop)
        return (sel?: Record<string, unknown>) => {
          if (sel && Object.keys(sel).join() === fields) throw overloaded()
          return Reflect.apply(target[method], target, [sel])
        }
      },
    }) as typeof real
  }
  /** Real D1, except that every delete fails as an overloaded D1 does. */
  const failingDelete = () => {
    const real = db()
    return new Proxy(real, {
      get: (target, prop) => (prop === 'delete' ? () => { throw overloaded() } : Reflect.get(target, prop)),
    }) as typeof real
  }

  it("joins the conversation the job's failure alerts opened", async () => {
    await seedSession(NJ)
    const started = await startOf('ls-sync')
    await sendRecoveries(env as any, db(), JOB, [rec])
    expect(sent()[0].headers).toEqual(await jobThreadHeaders(env as any, 'ls-sync', started))
  })

  it('ends the conversation when nothing in the job is still failing, so the next alert starts a new one', async () => {
    await seedSession(NJ)
    const started = await startOf('ls-sync')
    await sendRecoveries(env as any, db(), JOB, [rec])
    expect(await startOf('ls-sync', later())).not.toBe(started)
  })

  it('keeps the conversation open while another session in the job is still failing', async () => {
    await seedSession(NJ)
    await seedSession(US)
    await logRow(US, 0, 'failed')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0 + 2 * H)
    try {
      const started = await startOf('ls-sync')
      await sendRecoveries(env as any, db(), JOB, [rec])
      expect(sent()[0].text).toMatch(/still failing/i)
      expect(await startOf('ls-sync', later())).toBe(started)
    } finally { vi.useRealTimers() }
  })

  it("keeps the conversation open when it can't read which sessions are still failing", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedSession(NJ)
    const started = await startOf('ls-sync')
    await sendRecoveries(env as any, failingRead('selectDistinct', 'sessionId,state,sessionName'), JOB, [rec])
    expect(sent()).toHaveLength(1)
    expect(await startOf('ls-sync', later())).toBe(started)
  })

  it("still sends the resolved email, and lets the run go on, when the conversation can't be ended", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await seedSession(NJ)
    const started = await startOf('ls-sync')
    await expect(sendRecoveries(env as any, failingDelete(), JOB, [rec])).resolves.toBeUndefined()
    expect(sent()).toHaveLength(1)
    expect(sent()[0].headers).toEqual(await jobThreadHeaders(env as any, 'ls-sync', started))
  })

  it('starts a conversation of its own when no alert opened one', async () => {
    await seedSession(NJ)
    await sendRecoveries(env as any, db(), JOB, [rec])
    expect(sent()[0].headers['References']).toMatch(/^<alert\.ls-sync\./)
  })

  describe('for a calendar job', () => {
    const WARM = { job: 'govinfo-body-events', providerId: 'govinfo', name: 'GovInfo Bill Status' }
    const streak = (state: string) => ({
      key: `warm-streak:${WARM.job}:${state}`,
      value: JSON.stringify({ since: T0, last: T0 + 5 * H, failed: 6, due: T0 + 9 * H, alerted: true }),
    })

    it('joins the open conversation and ends it when the last failing state warms', async () => {
      await db().insert(settings).values(streak('US'))
      const started = await startOf(WARM.job)
      await warmEnded(env as any, db(), WARM, 'US', true)
      expect(sent()[0].subject).toContain(`resolved: ${WARM.job}`)
      expect(sent()[0].headers).toEqual(await jobThreadHeaders(env as any, WARM.job, started))
      expect(await startOf(WARM.job, later())).not.toBe(started)
    })

    it('keeps the conversation open while another state still fails to warm', async () => {
      await db().insert(settings).values([streak('US'), streak('VA')])
      const started = await startOf(WARM.job)
      await warmEnded(env as any, db(), WARM, 'US', true)
      expect(sent()).toHaveLength(1)
      expect(await startOf(WARM.job, later())).toBe(started)
    })

    it("still sends the resolved email, and keeps the conversation open, when it can't read whether another state still fails", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await db().insert(settings).values(streak('US'))
      const started = await startOf(WARM.job)
      await warmEnded(env as any, failingRead('select', 'key'), WARM, 'US', true)
      expect(sent()).toHaveLength(1)
      expect(sent()[0].subject).toContain(`resolved: ${WARM.job}`)
      // It joined the conversation, so only the still-failing read failed.
      expect(sent()[0].headers).toEqual(await jobThreadHeaders(env as any, WARM.job, started))
      expect(await startOf(WARM.job, later())).toBe(started)
    })

    it('ends the conversation when the job stops warming its only failing state', async () => {
      await db().insert(settings).values(streak('US'))
      const started = await startOf(WARM.job)
      await forgetWarmStreaks(env as any, db(), WARM, [])
      expect(sent()[0].headers).toEqual(await jobThreadHeaders(env as any, WARM.job, started))
      expect(await startOf(WARM.job, later())).not.toBe(started)
    })

    it("still sends the email when the job stops warming a failing state, even if it can't read the rest", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await db().insert(settings).values(streak('US'))
      await forgetWarmStreaks(env as any, failingRead('select', 'key'), WARM, [])
      expect(sent()).toHaveLength(1)
      expect(sent()[0].subject).toContain(`resolved: ${WARM.job}`)
    })
  })
})
