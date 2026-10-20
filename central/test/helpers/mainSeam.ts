import { env } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { processIngestorQueue } from '../../src/queue/processor'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'
import type { Provider } from '../../src/providers'
import { clearDb } from './migrations'

/**
 * The main seam for a provider's tests: its recorded feed in, central's bill
 * API and the notifications queued for tenants out. A test stubs the network
 * at `fetch` with the provider's recorded responses, then drives central the
 * way the cron, the ingestor, and an operator do, and checks only what a
 * tenant or operator would see:
 *
 *   vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
 *   vi.stubGlobal('fetch', fetchMock)
 *   const seam = mainSeam(mga, { tenantId: 'mdteam' })
 *
 *   beforeEach(async () => {
 *     await resetCentral()
 *     await seam.addTenant('MD', ['tax'])
 *   })
 *
 *   it('syncs Maryland once claimed', async () => {
 *     expect((await seam.claim('MD')).status).toBe(200)
 *     const { run } = await seam.syncAndIngest()
 *     expect(await seam.getJson(`/bills/${toHandle(await seam.billIdOf('HB1'))}`)).toMatchObject({ ... })
 *     expect(seam.sentToTenant(run)).toContainEqual(expect.objectContaining({ ... }))
 *   })
 *
 * A snapshot provider syncs through `runSnapshotSync`, the sync its hourly job
 * runs, which throws every failed session rather than waiting for a streak.
 * Every queue is a mock, so nothing is consumed until a test hands the queued
 * messages to the ingestor (`syncAndIngest`, `ingest`).
 */
export function mainSeam(provider: Provider, opts: {
  /** The instance whose notifications the run captures (`Run.tenantQueue`). */
  tenantId: string
  /** Env a provider needs on every run, such as its API key. */
  env?: Record<string, unknown>
}) {
  const db = () => drizzle(env.DB, { schema })

  /**
   * A fresh set of queues, and central's env with them bound. `queue` is
   * where the provider's ingests go: its own `ingestQueue` binding when it
   * declares one, and `INGESTOR_QUEUE` otherwise.
   */
  function makeRun() {
    const ingestor = mockQueue()
    const providerQueue = provider.ingestQueue ? mockQueue() : null
    const tenantQueue = mockQueue()
    const runEnv: Record<string, any> = {
      ...(env as any),
      ADMIN_SECRET,
      ...opts.env,
      INGESTOR_QUEUE: ingestor,
      ...(provider.ingestQueue ? { [provider.ingestQueue]: providerQueue } : {}),
      [tenantQueueBindingName(opts.tenantId)]: tenantQueue,
    }
    return { env: runEnv, ingestor, tenantQueue, queue: providerQueue ?? ingestor }
  }
  type Run = ReturnType<typeof makeRun>

  /** Every message queued for the provider's ingests: each bill's ingest, or a calendar recheck. */
  const queued = (run: Run): any[] => run.queue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))

  /** The bills queued for an ingest, leaving out calendar rechecks. */
  const queuedIds = (run: Run): number[] =>
    queued(run).filter(b => b.calendarRecheck === undefined).map(b => b.billId as number)

  /** Every message queued for the instance, whether sent alone or in a batch. */
  const sentToTenant = (run: Run): any[] => [
    ...run.tenantQueue.send.mock.calls.map(c => c[0]),
    ...run.tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
  ]

  /** A request to central's API (`/api` is added), as an operator with the admin secret. */
  async function central(method: string, path: string, run = makeRun(), body?: unknown): Promise<Response> {
    const { app } = await import('../../src/index')
    return app.fetch(new Request(`http://central/api${path}`, {
      method,
      headers: { 'x-admin-secret': ADMIN_SECRET, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), run.env)
  }

  /** A GET that must answer 200, and its JSON. */
  async function getJson(path: string, run = makeRun()): Promise<any> {
    const res = await central('GET', path, run)
    expect(res.status).toBe(200)
    return res.json()
  }

  /** An operator's claim of a state, for this provider unless another is named. */
  function claim(state: string, providerId = provider.id, run = makeRun()): Promise<Response> {
    return central('POST', `/admin/state-providers/${state}`, run, { provider: providerId })
  }

  /** The provider's hourly sync, with no ingest. */
  function sync(run = makeRun()) {
    return runSnapshotSync(provider, run.env as any, db())
  }

  /** Hand messages to the ingestor, as the queue consumer would. Each comes back with its `ack` and `retry` mocks. */
  async function consume(bodies: unknown[], run: Run) {
    const messages = bodies.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
    if (messages.length > 0) await processIngestorQueue({ messages } as any, run.env as any, db())
    return messages
  }

  /**
   * The hourly sync, then every message it queued, each consumed once. Fails
   * if any message was retried, unless `allowRetries` (for a test of an
   * ingest failing closed).
   */
  async function syncAndIngest(run = makeRun(), { allowRetries = false } = {}) {
    await sync(run)
    const messages = await consume(queued(run), run)
    if (!allowRetries) for (const m of messages) expect(m.retry, JSON.stringify(m.body)).not.toHaveBeenCalled()
    return { run, messages }
  }

  /** One ingest of each bill, as a re-ingest would queue it. Returns the consumed messages, unchecked. */
  function ingest(billIds: number | number[], run = makeRun()) {
    return consume((Array.isArray(billIds) ? billIds : [billIds]).map(billId => ({ billId })), run)
  }

  /** An active instance covering these states, with these keywords. Defaults to the seam's instance. */
  async function addTenant(states: string | string[], keywords: string[], tenantId = opts.tenantId) {
    const coverage = Array.isArray(states) ? states : [states]
    await db().insert(schema.tenants).values({ tenantId, name: tenantId, stateCoverage: JSON.stringify(coverage), active: true })
    if (keywords.length > 0) await db().insert(schema.keywordRegistry).values(keywords.map(keyword => ({ tenantId, keyword })))
  }

  /** A bill's central id by number, from the session with this tag when the number repeats across sessions. */
  async function billIdOf(number: string, sessionTag?: string): Promise<number> {
    const rows = await db().select({ billId: schema.bills.billId, tag: schema.sessions.sessionTag }).from(schema.bills)
      .leftJoin(schema.sessions, eq(schema.sessions.sessionId, schema.bills.sessionId))
      .where(eq(schema.bills.billNumber, number)).all()
    const row = sessionTag === undefined ? rows[0] : rows.find(r => r.tag === sessionTag)
    if (!row) throw new Error(`no bill ${number}${sessionTag === undefined ? '' : ` in ${sessionTag}`}`)
    return row.billId
  }

  return { db, makeRun, queued, queuedIds, sentToTenant, central, getJson, claim, sync, syncAndIngest, ingest, addTenant, billIdOf }
}

export type MainSeam = ReturnType<typeof mainSeam>
export type Run = ReturnType<MainSeam['makeRun']>

/** The admin secret every run's env carries. */
export const ADMIN_SECRET = 'test-secret'

/**
 * A fresh central for each test: every migration applied to an empty D1,
 * every mock's calls cleared, and the clock frozen at `at` (by default 5 ET
 * on a Monday, the hour sessions refresh). Pair it with
 * `afterEach(() => vi.useRealTimers())`.
 */
export async function resetCentral(at = '2026-09-28T09:00:00Z'): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(at))
  await clearDb()
  vi.clearAllMocks()
}

function mockQueue() {
  return { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
}
