import { sql } from 'drizzle-orm'
import { bills } from '../db/schema'
import { getDb } from '../db/client'
import { centralFetch } from './centralFetch'
import { runDemoReset } from './demoReset'
import { resolveDemoSeed } from './demoSeeds'
import type { Env } from '../types'

export async function demoResetAndSeed(env: Env): Promise<{ ok: boolean; billsSeeded: boolean }> {
  // Intrinsic safety guard: a demo reset is destructive and must never run on a
  // non-demo tenant. The HTTP route also 404s before calling, but the RPC path
  // (CentralApi.demoReset) reaches here directly, so guard here too.
  if (env.DEMO_MODE !== 'true') throw new Error('demo mode not enabled')
  const db = getDb(env.DB)
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(bills).all()
  let billsSeeded = false
  if (count === 0) {
    if (env.PROVIDER === 'legiscan') {
      let offset = 0
      for (let iter = 0; iter < 200; iter++) {
        const res = await centralFetch(env, `/tenants/reprocess/${env.TENANT_ID}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offset }),
        })
        if (!res.ok) break
        billsSeeded = true
        const j = await res.json().catch(() => ({})) as { hasMore?: boolean; nextOffset?: number }
        if (!j.hasMore) break
        offset = typeof j.nextOffset === 'number' ? j.nextOffset : offset + 1000
      }
    } else {
      const res = await centralFetch(env, `/admin/reprocess-tenant/${env.TENANT_ID}`, { method: 'POST' })
      billsSeeded = res.ok
    }
  }
  await runDemoReset(env.DB, resolveDemoSeed(env.DEMO_SEED))
  return { ok: true, billsSeeded }
}
