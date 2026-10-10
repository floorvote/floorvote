import { eq } from 'drizzle-orm'
import { tenants } from '../db/schema'
import { nowDb } from '../lib/dbTime'
import { providerContext } from '../lib/providerContext'
import { providerConfigured } from '../lib/providerRouting'
import { loadStateOwners, statesOwnedBy } from '../lib/stateProviders'
import { syncBodyEvents, type BodyEventSyncReport } from '../lib/bodyEvents'
import type { Provider } from '../providers'
import type { Env, Db } from '../types'

/**
 * The hourly sync of a provider's own calendar (Provider.listBodyEvents,
 * lib/bodyEvents.ts), for each state the ownership table gives it that an
 * instance covers. One job per provider, beside its snapshot sync, so a
 * calendar outage never stops bills from syncing, or the other way round.
 * Hourly because an event missing from two pulls in a row is cancelled: a
 * hearing the legislature drops leaves calendars within about two hours.
 */
export async function runBodyEventSync(provider: Provider, env: Env, db: Db): Promise<BodyEventSyncReport[]> {
  if (!provider.listBodyEvents) return []
  const owned = statesOwnedBy(await loadStateOwners(env, db), provider.id)
  // The snapshot sync warns about an owner that isn't configured.
  if (owned.length === 0 || !providerConfigured(provider, env)) return []

  const coverage = (await db.select({ stateCoverage: tenants.stateCoverage }).from(tenants).where(eq(tenants.active, true)).all())
    .map(t => {
      try { return JSON.parse(t.stateCoverage) as string[] } catch { return [] }
    })
  const covered = owned.filter(state => coverage.some(cov => cov.includes('*') || cov.includes(state)))
  if (covered.length === 0) return []

  const ctx = providerContext(provider, env, db)
  const reports: BodyEventSyncReport[] = []
  for (const state of covered) {
    const report = await syncBodyEvents(provider, state, range => provider.listBodyEvents!(state, range, ctx), db, ctx.today, nowDb())
    console.log(`[body-events] ${provider.id} ${state}: ${report.events} events over ${report.months} months (${report.failed} failed), ${report.written} written`)
    reports.push(report)
  }
  return reports
}
