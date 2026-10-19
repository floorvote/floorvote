import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import { revokeSuperadminJti, isSuperadminJtiRevoked, pruneRevokedSuperadminJtis } from '../../src/lib/superadminRevocation'
import { pruneCallLogs } from '../../src/lib/pruneCallLogs'
import worker from '../../src/index-legiscan'

// The retention job rides central's hourly cron, once a day with the other daily
// jobs, and as its own job: if it fails, the rest of that cron still runs.

vi.mock('../../src/lib/pruneCallLogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/pruneCallLogs')>()),
  pruneCallLogs: vi.fn(async () => ({ apiCallLog: 0, sessionSyncLog: 0 })),
}))
vi.mock('../../src/lib/superadminRevocation', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/superadminRevocation')>()
  return { ...real, pruneRevokedSuperadminJtis: vi.fn(real.pruneRevokedSuperadminJtis) }
})
const prune = vi.mocked(pruneCallLogs)
const pruneJtis = vi.mocked(pruneRevokedSuperadminJtis)

const db = () => drizzle(env.DB, { schema })

async function tick(isoUtc: string) {
  vi.setSystemTime(new Date(isoUtc))
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException() {} } as unknown as ExecutionContext
  await worker.scheduled!({ cron: '0 * * * *', scheduledTime: Date.now() } as ScheduledController, { ...env, ALERT_EMAILS: '' } as any, ctx)
  await Promise.all(pending)
}

beforeEach(async () => {
  await setupLsDb()
  prune.mockReset()
  pruneJtis.mockClear()
  prune.mockImplementation(async () => ({ apiCallLog: 0, sessionSyncLog: 0 }))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('scheduled: call-log retention', () => {
  it('prunes the call logs on the daily tick', async () => {
    await tick('2026-10-14T06:00:00Z')
    expect(prune).toHaveBeenCalledTimes(1)
  })

  it('does not prune on the other hours', async () => {
    for (const h of ['00', '05', '07', '12', '23']) await tick(`2026-10-14T${h}:00:00Z`)
    expect(prune).not.toHaveBeenCalled()
  })

  it('still runs the rest of the daily jobs when the prune fails', async () => {
    await revokeSuperadminJti(db(), 'old-token', Math.floor(Date.parse('2026-10-14T05:00:00Z') / 1000))
    prune.mockRejectedValue(new Error('D1 is down'))
    await tick('2026-10-14T06:00:00Z')
    expect(prune).toHaveBeenCalledTimes(1)
    // The revocation prune is another daily job: it ran after the failed one.
    expect(await isSuperadminJtiRevoked(db(), 'old-token')).toBe(false)
  })

  it('does not let a failing sibling daily job stop the prune', async () => {
    pruneJtis.mockRejectedValueOnce(new Error('settings table locked'))
    await tick('2026-10-14T06:00:00Z')
    expect(pruneJtis).toHaveBeenCalledTimes(1)
    expect(prune).toHaveBeenCalledTimes(1)
  })
})
