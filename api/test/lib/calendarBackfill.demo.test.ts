import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { backfillCalendar } from '../../src/lib/calendarBackfill'

/**
 * backfillCalendar is the shared helper behind three visitor-reachable routes:
 * PATCH /bills/:id/priority, the bulk priority action, and the calendar route.
 * It POSTs central /tenants/reprocess, which re-delivers the bill to the tenant
 * queue — the path that used to re-run AI on a mere priority change.
 *
 * The processor's DEMO_MODE guard is what actually prevents the model call.
 * This asserts the near-side half: a demo makes no central call at all, so a
 * visitor action generates no traffic and no queue message.
 */
describe('backfillCalendar — demo tenants', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
  })

  it('makes no central call on a demo tenant', async () => {
    const demoEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test', DEMO_MODE: 'true' }
    await backfillCalendar(demoEnv as any, [12345])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still calls central on a normal tenant', async () => {
    const realEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }
    await backfillCalendar(realEnv as any, [12345])
    expect(fetch).toHaveBeenCalled()
  })

  it('makes no call when there are no bills, demo or not', async () => {
    const realEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }
    await backfillCalendar(realEnv as any, [])
    expect(fetch).not.toHaveBeenCalled()
  })
})
