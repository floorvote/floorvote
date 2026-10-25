import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { sessions, tenants } from '../../src/db/schema'

// A LegiScan pass that fails is logged as failed, as a snapshot provider's is,
// and the hourly cron alerts on a state's 4th failed pass in a row and every
// 4th after, in one email for every state that reached a multiple that run. A
// state that alerted gets one email when it syncs again. An empty answer (a
// session with no bills yet) is a pass that finished, never a failure.
vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return { ...actual, getMasterListBySession: vi.fn(), getMasterListRaw: vi.fn(), getSessionList: vi.fn().mockResolvedValue([]) }
})
vi.mock('../../src/lib/queuesRest', () => ({
  publishBatch: vi.fn().mockResolvedValue(undefined),
  publishMessage: vi.fn().mockResolvedValue(undefined),
  queuesRestEnabled: () => true,
}))
vi.mock('../../src/lib/jobAlert', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/jobAlert')>('../../src/lib/jobAlert')
  return { ...actual, sendOpsAlert: vi.fn().mockResolvedValue(undefined) }
})

import { runSync } from '../../src/cron/sync'
import { FAILED_PASSES_BEFORE_ALERT } from '../../src/cron/passAlerts'
import * as legiscan from '../../src/providers/legiscan/client'
import { sendOpsAlert } from '../../src/lib/jobAlert'
import { clearDb } from '../helpers/migrations'
import { PRODUCT_NAME } from '../../../shared/brand'

const db = () => drizzle(env.DB, { schema })
const EVERY_HOUR = JSON.stringify(Array.from({ length: 24 }, (_, h) => h))
const NJ = { sessionId: 7001, state: 'NJ', name: '2026-2027 Regular Session' }
const US = { sessionId: 7002, state: 'US', name: '119th Congress' }
const syncEnv = () => ({ ...(env as any), INGESTOR_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() } })

let clock = 0
const nextHour = () => vi.setSystemTime(clock += 3_600_000)

async function seed(kind: 'full' | 'raw', ...ss: (typeof NJ)[]) {
  await db().insert(sessions).values(ss.map(s => ({
    sessionId: s.sessionId, state: s.state, stateId: 1, yearStart: 2026, yearEnd: 2027,
    sessionTitle: s.name, sessionName: s.name,
    fullSyncHoursEt: kind === 'full' ? EVERY_HOUR : '[]',
    rawSyncHoursEt: kind === 'raw' ? EVERY_HOUR : '[]',
  })))
  await db().insert(tenants).values({ tenantId: 't', name: 'T', stateCoverage: JSON.stringify(ss.map(s => s.state)), active: true })
}
const down = (message = 'LegiScan HTTP 503') => vi.mocked(legiscan.getMasterListBySession).mockRejectedValue(new Error(message))
const up = () => vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([])
// Each pass an hour on, swallowing what the last one throws.
async function passes(n: number) {
  for (let i = 0; i < n; i++) { await runSync(syncEnv(), db()).catch(() => {}); nextHour() }
}
const logRows = () => db().select().from(schema.sessionSyncLog).orderBy(schema.sessionSyncLog.id).all()
const resolvedEmails = () => vi.mocked(sendOpsAlert).mock.calls.map(c => c[1]).filter(m => m.subject.includes('resolved'))

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  vi.mocked(legiscan.getSessionList).mockResolvedValue([])
  clock = Date.parse('2026-10-20T12:00:00Z')
  vi.setSystemTime(clock)
})
afterEach(async () => {
  vi.useRealTimers()
  await env.DB.exec('DROP TRIGGER IF EXISTS no_failed_rows')
})

describe('a LegiScan pass that fails', () => {
  it('is logged as failed, with its error, and stays quiet', async () => {
    await seed('full', NJ)
    down()
    await expect(runSync(syncEnv(), db())).resolves.toBeUndefined()
    expect(await logRows()).toMatchObject([{ state: 'NJ', sessionName: NJ.name, status: 'failed', error: 'LegiScan HTTP 503' }])
  })

  it('alerts on the 4th in a row, naming the state, the session, the count, and the error', async () => {
    await seed('full', NJ)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT - 1)
    const err = await runSync(syncEnv(), db()).then(() => null, (x: Error) => x)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain(`NJ ${NJ.name}: ${FAILED_PASSES_BEFORE_ALERT} passes in a row failed`)
    expect(err!.message).toContain('LegiScan HTTP 503')
  })

  it('stays quiet on the passes after an alert, and alerts again on the 4th of them', async () => {
    await seed('full', NJ)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT)
    for (let i = 1; i < FAILED_PASSES_BEFORE_ALERT; i++) {
      await expect(runSync(syncEnv(), db())).resolves.toBeUndefined()
      nextHour()
    }
    await expect(runSync(syncEnv(), db())).rejects.toThrow(`${2 * FAILED_PASSES_BEFORE_ALERT} passes in a row`)
  })

  it('alerts once for several states that reach the threshold in the same run', async () => {
    await seed('full', NJ, US)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT - 1)
    const err = await runSync(syncEnv(), db()).then(() => null, (x: Error) => x)
    expect(err).toBeInstanceOf(AggregateError)
    expect(err!.message).toContain(`NJ ${NJ.name}`)
    expect(err!.message).toContain(`US ${US.name}`)
  })

  it('starts the count again after a pass that finishes', async () => {
    await seed('full', NJ)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT - 1)
    up()
    await passes(1)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT - 1)
    await expect(runSync(syncEnv(), db())).rejects.toThrow(`${FAILED_PASSES_BEFORE_ALERT} passes in a row`)
  })

  it('alerts at once when its failed row can\'t be logged, since the streak can\'t be counted', async () => {
    await seed('full', NJ)
    await env.DB.exec(`CREATE TRIGGER no_failed_rows BEFORE INSERT ON session_sync_log WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'log refused'); END`)
    down()
    await expect(runSync(syncEnv(), db())).rejects.toThrow('LegiScan HTTP 503')
  })
})

describe('a LegiScan session with no bills', () => {
  it('is never counted as failing on a full pass', async () => {
    await seed('full', NJ)
    vi.mocked(legiscan.getMasterListBySession).mockResolvedValue([])
    for (let i = 0; i < 2 * FAILED_PASSES_BEFORE_ALERT; i++) {
      await expect(runSync(syncEnv(), db())).resolves.toBeUndefined()
      nextHour()
    }
    const rows = await logRows()
    expect(rows).toHaveLength(2 * FAILED_PASSES_BEFORE_ALERT)
    expect(rows.every(r => r.status === 'ok')).toBe(true)
  })

  it('is never counted as failing on a light check that finds no changes', async () => {
    await seed('raw', NJ)
    vi.mocked(legiscan.getMasterListRaw).mockResolvedValue([])
    for (let i = 0; i < 2 * FAILED_PASSES_BEFORE_ALERT; i++) {
      await expect(runSync(syncEnv(), db())).resolves.toBeUndefined()
      nextHour()
    }
    const rows = await logRows()
    expect(rows).toHaveLength(2 * FAILED_PASSES_BEFORE_ALERT)
    expect(rows.every(r => r.status === 'ok')).toBe(true)
  })
})

describe('the email once a LegiScan state that alerted syncs again', () => {
  it('sends one, naming the state and how many passes failed, on the pass that finishes', async () => {
    await seed('full', NJ)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT)
    up()
    await runSync(syncEnv(), db())
    const sent = resolvedEmails()
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe(`[${PRODUCT_NAME}] resolved: ls-sync`)
    expect(sent[0].text).toContain(`NJ ${NJ.name}`)
    expect(sent[0].text).toContain(`${FAILED_PASSES_BEFORE_ALERT} failed passes in a row`)
  })

  it('sends none for a state that recovers before it alerted', async () => {
    await seed('full', NJ)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT - 1)
    up()
    await runSync(syncEnv(), db())
    expect(resolvedEmails()).toHaveLength(0)
  })

  it('sends one for several states that recover in the same run', async () => {
    await seed('full', NJ, US)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT)
    up()
    await runSync(syncEnv(), db())
    const sent = resolvedEmails()
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain(`NJ ${NJ.name}`)
    expect(sent[0].text).toContain(`US ${US.name}`)
  })

  it('sends one recovery when two passes finish together', async () => {
    await seed('full', NJ)
    down()
    await passes(FAILED_PASSES_BEFORE_ALERT)
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    let reads = 0
    vi.mocked(legiscan.getMasterListBySession).mockImplementation(async () => {
      if (++reads === 2) release()
      await ready
      return []
    })
    await Promise.all([runSync(syncEnv(), db()), runSync(syncEnv(), db())])
    expect(resolvedEmails()).toHaveLength(1)
  })
})
