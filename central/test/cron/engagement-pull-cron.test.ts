import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'
import { pullEngagementStats, ENGAGEMENT_PULL_CRON } from '../../src/cron/engagement-pull'
import { runSync } from '../../src/cron/sync'
import exampleRaw from '../../wrangler.example.toml?raw'
import worker from '../../src/index'

// The engagement pull times each tenant's round trip, so it runs in its own
// invocation, clear of the hourly sync, whose outbound calls held its RPCs back
// for up to a minute on the shared tick. A config without the cron still gets
// its pull, from the hourly tick at 07:00, when nothing was pulled that day.

vi.mock('../../src/cron/engagement-pull', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cron/engagement-pull')>()),
  pullEngagementStats: vi.fn(async () => {}),
}))
vi.mock('../../src/cron/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cron/sync')>()),
  runSync: vi.fn(async () => {}),
}))
const pull = vi.mocked(pullEngagementStats)
const sync = vi.mocked(runSync)

const db = () => drizzle(env.DB, { schema })

async function tick(cron: string, isoUtc: string) {
  vi.setSystemTime(new Date(isoUtc))
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException() {} } as unknown as ExecutionContext
  await worker.scheduled!({ cron, scheduledTime: Date.now() } as ScheduledController, { ...env, ALERT_EMAILS: '' } as any, ctx)
  await Promise.all(pending)
}

async function seedPulledRow(statDate: string) {
  await db().insert(schema.tenants).values({ tenantId: 't1', name: 'T1', apiUrl: 'https://t1.example', stateCoverage: '[]' } as any)
  await db().insert(schema.tenantStats).values({ tenantId: 't1', statDate, pulledAt: `${statDate} 06:15:00` } as any)
}

beforeEach(async () => {
  await clearDb()
  pull.mockClear()
  sync.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('scheduled: engagement pull', () => {
  it('runs on its own cron, quarter past six UTC, and nothing else does', async () => {
    expect(ENGAGEMENT_PULL_CRON).toBe('15 6 * * *')
    await tick(ENGAGEMENT_PULL_CRON, '2026-10-22T06:15:00Z')
    expect(pull).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()
  })

  it('is not run by the hourly tick at six', async () => {
    await tick('0 * * * *', '2026-10-22T06:00:00Z')
    expect(sync).toHaveBeenCalledTimes(1)
    expect(pull).not.toHaveBeenCalled()
  })

  it('is run by the hourly tick at seven when nothing was pulled that day', async () => {
    await seedPulledRow('2026-10-21')
    await tick('0 * * * *', '2026-10-22T07:00:00Z')
    expect(pull).toHaveBeenCalledTimes(1)
  })

  it('is not run again at seven when its own cron already pulled', async () => {
    await seedPulledRow('2026-10-22')
    await tick('0 * * * *', '2026-10-22T07:00:00Z')
    expect(pull).not.toHaveBeenCalled()
  })

  it('is scheduled in the example config', () => {
    const crons = exampleRaw.match(/\[env\.legiscan\.triggers\]\ncrons = (\[.*\])/)?.[1]
    expect(JSON.parse(crons ?? '[]')).toEqual(['0 * * * *', ENGAGEMENT_PULL_CRON])
  })
})
