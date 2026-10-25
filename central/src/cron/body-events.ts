import { eq } from 'drizzle-orm'
import { tenants } from '../db/schema'
import { nowDb } from '../lib/dbTime'
import { providerContext } from '../lib/providerContext'
import { providerConfigured } from '../lib/providerRouting'
import { loadStateOwners, statesOwnedBy } from '../lib/stateProviders'
import { syncBodyEvents, type BodyEventSyncReport } from '../lib/bodyEvents'
import { forgetWarmStreaks, warmEnded, warmFailed, type SyncJob } from './passAlerts'
import type { Provider } from '../providers'
import type { Env, Db } from '../types'

/** What warming a state's cache came to (Provider.warmBodyEvents): whether the cache is now ready, or why the pass failed. */
export type BodyEventWarmReport =
  | { state: string; ok: true; warm: boolean }
  | { state: string; ok: false; error: string }

export interface BodyEventJobReport {
  /** One for each state the provider owns that an instance covers. */
  synced: BodyEventSyncReport[]
  /** One for each state the provider serves but doesn't own yet that an instance covers, and that it warmed or tried to. */
  warmed: BodyEventWarmReport[]
}

/**
 * The hourly sync of a provider's own calendar (Provider.listBodyEvents,
 * lib/bodyEvents.ts), for each state the ownership table gives it that an
 * instance covers. One job per provider, beside its snapshot sync, so a
 * calendar outage never stops bills from syncing, or the other way round.
 * Hourly because an event missing from two pulls in a row is cancelled: a
 * hearing the legislature drops leaves calendars within about two hours.
 *
 * A provider with `warmBodyEvents` also warms its cache for each state it
 * serves but doesn't own yet that an instance covers (#913), writing nothing
 * a calendar shows. A failure there is logged and reported in `warmed`, never
 * thrown, so it never stops the owned states' sync. Warming that keeps
 * failing emails the operators on the sync jobs' cadence, and once more when
 * it works again (#979, passAlerts.ts). A warm with nothing to do (no key)
 * never alerts.
 */
export async function runBodyEventJob(provider: Provider, env: Env, db: Db): Promise<BodyEventJobReport> {
  const none: BodyEventJobReport = { synced: [], warmed: [] }
  if (!provider.listBodyEvents) return none
  // The snapshot sync warns about an owner that isn't configured.
  if (!providerConfigured(provider, env)) return none
  const owned = statesOwnedBy(await loadStateOwners(db), provider.id)
  const unowned = provider.warmBodyEvents ? (provider.states ?? []).filter(state => !owned.includes(state)) : []
  if (owned.length === 0 && unowned.length === 0) return none

  const isCovered = await coveredBy(db)
  const covered = owned.filter(isCovered)
  const warming = unowned.filter(isCovered)
  const job = bodyEventJob(provider)
  if (provider.warmBodyEvents) await forgetWarmStreaks(env, db, job, warming)
  if (covered.length === 0 && warming.length === 0) return none

  const ctx = providerContext(provider, env, db)
  const out: BodyEventJobReport = { synced: [], warmed: [] }
  for (const state of covered) {
    const report = await syncBodyEvents(provider, state, range => provider.listBodyEvents!(state, range, ctx), db, ctx.today, nowDb())
    console.log(`[body-events] ${provider.id} ${state}: ${report.events} events over ${report.months} months (${report.failed} failed), ${report.written} written`)
    out.synced.push(report)
  }
  for (const state of warming) {
    try {
      const result = await provider.warmBodyEvents!(state, ctx)
      await warmEnded(env, db, job, state, !!result)
      // Null: nothing to do (no key, say), so nothing to log or report.
      if (!result) continue
      console.log(`[body-events] ${provider.id} ${state}: warmed the cache before owning the state; ${result.warm ? 'it is ready' : 'more to read'}`)
      out.warmed.push({ state, ok: true, warm: result.warm })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[body-events] ${provider.id} ${state}: warming the cache failed, and the next pass tries again: ${error}`)
      out.warmed.push({ state, ok: false, error })
      await warmFailed(env, db, job, state, err instanceof Error ? err : new Error(error))
    }
  }
  return out
}

/** The name the hourly cron runs a provider's body-event job under (index.ts), which its alert emails carry. */
export function bodyEventJobName(provider: Provider): string {
  return `${provider.id}-body-events`
}

function bodyEventJob(provider: Provider): SyncJob {
  return { job: bodyEventJobName(provider), providerId: provider.id, name: provider.displayName }
}

/** The owned states' reports from `runBodyEventJob`, for a caller that needs only those. */
export async function runBodyEventSync(provider: Provider, env: Env, db: Db): Promise<BodyEventSyncReport[]> {
  return (await runBodyEventJob(provider, env, db)).synced
}

/** Whether an active instance covers a state, by name or with `*`. */
async function coveredBy(db: Db): Promise<(state: string) => boolean> {
  const coverage = (await db.select({ stateCoverage: tenants.stateCoverage }).from(tenants).where(eq(tenants.active, true)).all())
    .map(t => {
      try { return JSON.parse(t.stateCoverage) as string[] } catch { return [] }
    })
  return state => coverage.some(cov => cov.includes('*') || cov.includes(state))
}
