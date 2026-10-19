import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import worker from '../../src/index'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'
import { SINGLE_STATE_SEED } from '../fixtures/singleStateDemoSeed'
import { LEGISCAN_ATTRIBUTION } from '../../../shared/dataAttribution'

// The demo's scheduled run resets and returns: it never reaches syncBodyEvents,
// the only writer of `data_attribution`. So the demo's GET /config carried no
// attribution and the bill list offered the empty Stage filter (#676).

type ConfigBody = { attribution?: { providers: { id: string }[] } }

async function demoScheduled() {
  const ctx = createExecutionContext()
  const controller = createScheduledController({ cron: '0 */6 * * *' })
  await worker.scheduled(controller as unknown as ScheduledEvent, { ...env, DEMO_MODE: 'true' } as any, ctx)
  await waitOnExecutionContext(ctx)
}

describe('demo attribution (#676)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  // A reset deletes every non-seed user and session, so sign in after it.
  const getConfig = async (extra: Record<string, unknown> = {}) => {
    const cookie = `session=${await seedSession(await seedUser({ role: 'member' }))}`
    const res = await app.request('/api/config', { headers: { Cookie: cookie } }, { ...env, ...extra })
    expect(res.status).toBe(200)
    return await res.json() as ConfigBody
  }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => fetchSpy.mockRestore())

  it('serves LegiScan-only attribution after the demo scheduled run', async () => {
    await demoScheduled()
    const body = await getConfig({ DEMO_MODE: 'true' })
    expect(body.attribution?.providers.map(p => p.id)).toEqual(['legiscan'])
    expect(body.attribution?.providers[0]).toMatchObject({ name: LEGISCAN_ATTRIBUTION.name, url: LEGISCAN_ATTRIBUTION.url })
  })

  it('serves the same attribution after runDemoReset on the shipped seed', async () => {
    await runDemoReset(env.DB, DEMO_SEEDS['lake-michigan'])
    const body = await getConfig()
    expect(body.attribution?.providers.map(p => p.id)).toEqual(['legiscan'])
  })

  it('stays idempotent: a second reset leaves one attribution row with the same providers', async () => {
    await runDemoReset(env.DB, DEMO_SEEDS['lake-michigan'])
    const first = (await getConfig()).attribution
    await runDemoReset(env.DB, DEMO_SEEDS['lake-michigan'])
    const rows = await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'data_attribution')).all()
    expect(rows).toHaveLength(1)
    expect((await getConfig()).attribution).toEqual(first)
  })

  it('makes no outside network call on the demo path', async () => {
    await demoScheduled()
    await runDemoReset(env.DB, DEMO_SEEDS['lake-michigan'])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leaves attribution out for a seed that declares none, so unknown still shows the filter', async () => {
    await runDemoReset(env.DB, SINGLE_STATE_SEED)
    expect((await getConfig()).attribution).toBeUndefined()
  })

  it('still leaves attribution out on a real instance central has not answered', async () => {
    expect((await getConfig()).attribution).toBeUndefined()
  })
})
