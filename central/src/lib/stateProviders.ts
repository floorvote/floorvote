import { and, asc, countDistinct, eq, sql } from 'drizzle-orm'
import { bills, billTenants, sessions, stateProviders } from '../db/schema'
import { DEFAULT_PROVIDER_ID, PROVIDERS } from '../providers'
import { providerConfigured } from './providerRouting'
import type { Db, Env } from '../types'

/**
 * State ownership: which provider central reads each state from, one row per
 * state in state_providers. A state with no row is LegiScan's
 * (DEFAULT_PROVIDER_ID), so a LegiScan-only central has no rows. Each sync
 * reads the table and syncs only the states its provider owns, so every state
 * is decided on its own.
 *
 * A claim gives a state to another provider. It is refused while the state's
 * current owner has tracked bills there, meaning bills linked to an instance
 * (monitor links included, since instances hold those bills too). The new
 * provider would give each of them a second copy under a new id, and
 * instances would see, and pay AI for, both. Meanwhile the state keeps
 * syncing from its owner. Only a cutover moves a state with tracked bills.
 */

/** A state's provider as the admin read reports it. */
export interface StateOwnership {
  state: string
  provider: string
  status: string
  /** The provider the state had before the row was last written. */
  previousProvider: string | null
  /** When the row was last written. Null for a state with no row. */
  claimedAt: string | null
}

/** Why a claim was refused: the owner's tracked bills in the state, and the instances tracking them. */
export interface ClaimRefusal {
  owner: string
  trackedBills: number
  instances: string[]
}

export type ClaimResult =
  | { ok: true; changed: boolean; ownership: StateOwnership }
  | ({ ok: false } & ClaimRefusal)

/** The provider of each state with a row. Read a state's owner with `ownerOf`. */
export type StateOwners = ReadonlyMap<string, string>

export function ownerOf(owners: StateOwners, state: string): string {
  return owners.get(state) ?? DEFAULT_PROVIDER_ID
}

/** The states whose row names this provider. */
export function statesOwnedBy(owners: StateOwners, providerId: string): string[] {
  return [...owners].filter(([, provider]) => provider === providerId).map(([state]) => state)
}

/**
 * Every state's owner, as a sync reads it. For one release it first seeds rows
 * from the providers' old env vars (seedFromEnv), so whichever sync runs first
 * writes them and every sync agrees. `reportRefusals` logs each refused seed:
 * only the LegiScan sync sets it, so a refusal is logged once an hour, not
 * once per job.
 */
export async function loadStateOwners(env: Env, db: Db, opts: { reportRefusals?: boolean } = {}): Promise<StateOwners> {
  const read = async () => new Map((await db.select({ state: stateProviders.state, provider: stateProviders.provider })
    .from(stateProviders).all()).map(r => [r.state, r.provider]))
  const owners = await read()
  return (await seedFromEnv(env, db, owners, !!opts.reportRefusals)) ? read() : owners
}

/** One state's owner, read now. */
export async function ownerOfState(db: Db, state: string): Promise<string> {
  const row = await db.select({ provider: stateProviders.provider }).from(stateProviders)
    .where(eq(stateProviders.state, state)).get()
  return row?.provider ?? DEFAULT_PROVIDER_ID
}

/**
 * Link a bill to an instance, in one statement that writes only while
 * `provider` still owns the bill's state. A sync reads ownership once, when it
 * starts, so a claim can land while it runs. This makes the link and the claim
 * serialize: either the link lands first and the claim counts it and is
 * refused, or the claim lands first and the link isn't written. An existing
 * link is left alone.
 */
export function insertLinkWhileOwner(
  db: Db, link: { billId: number; tenantId: string; matchType: string | null }, state: string, provider: string,
) {
  // A query builder rather than db.run, so it can go in a db.batch. Drizzle
  // inserts every bill_tenants column in schema order: bill_id, tenant_id,
  // notified_at, match_type.
  return db.insert(billTenants).select(sql`
    SELECT ${link.billId}, ${link.tenantId}, NULL, ${link.matchType}
    WHERE COALESCE((SELECT provider FROM state_providers WHERE state = ${state}), ${DEFAULT_PROVIDER_ID}) = ${provider}`)
    .onConflictDoNothing()
}

/** Every row, by state. */
export async function listStateOwnership(db: Db): Promise<StateOwnership[]> {
  return db.select().from(stateProviders).orderBy(asc(stateProviders.state)).all()
}

/**
 * Give a state to a provider, unless its current owner has tracked bills
 * there. Claiming a state for its current owner changes nothing.
 */
export async function claimState(db: Db, state: string, providerId: string): Promise<ClaimResult> {
  // The write re-checks the owner and its tracked bills itself. If either
  // moved since the read, it writes nothing and the claim looks again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.select().from(stateProviders).where(eq(stateProviders.state, state)).get()
    const owner = row?.provider ?? DEFAULT_PROVIDER_ID
    if (owner === providerId) {
      return { ok: true, changed: false, ownership: row ?? defaultOwnership(state) }
    }
    const refusal = await trackedBills(db, state, owner)
    if (refusal.trackedBills > 0) return { ok: false, ...refusal }
    if (await writeClaim(db, state, providerId, owner, 'claim')) {
      const written = await db.select().from(stateProviders).where(eq(stateProviders.state, state)).get()
      return { ok: true, changed: true, ownership: written! }
    }
  }
  throw new Error(`ownership of ${state} kept changing during the claim; try again`)
}

function defaultOwnership(state: string): StateOwnership {
  return { state, provider: DEFAULT_PROVIDER_ID, status: 'active', previousProvider: null, claimedAt: null }
}

/** The owner's bills in the state that are linked to an instance, and those instances. */
async function trackedBills(db: Db, state: string, owner: string): Promise<ClaimRefusal> {
  const where = and(eq(bills.state, state), eq(bills.provider, owner))
  const count = await db.select({ n: countDistinct(bills.billId) }).from(bills)
    .innerJoin(billTenants, eq(billTenants.billId, bills.billId)).where(where).get()
  const n = Number(count?.n ?? 0)
  if (n === 0) return { owner, trackedBills: 0, instances: [] }
  const instances = await db.selectDistinct({ tenantId: billTenants.tenantId }).from(bills)
    .innerJoin(billTenants, eq(billTenants.billId, bills.billId)).where(where)
    .orderBy(asc(billTenants.tenantId)).all()
  return { owner, trackedBills: n, instances: instances.map(r => r.tenantId) }
}

/**
 * Write a state's row in one statement that holds only while `owner` still
 * owns the state and has no tracked bills there, so a link or another claim
 * landing between the check and the write can't get past the rule. A 'seed'
 * writes only a state with no row. Returns whether it wrote.
 */
async function writeClaim(db: Db, state: string, providerId: string, owner: string, mode: 'claim' | 'seed'): Promise<boolean> {
  const onConflict = mode === 'seed'
    ? sql`DO NOTHING`
    : sql`DO UPDATE SET provider = excluded.provider, status = excluded.status,
        previous_provider = excluded.previous_provider, claimed_at = excluded.claimed_at
      WHERE state_providers.provider = ${owner}`
  const result = await db.run(sql`
    INSERT INTO state_providers (state, provider, status, previous_provider, claimed_at)
    SELECT ${state}, ${providerId}, 'active', ${owner}, datetime('now')
    WHERE NOT EXISTS (
      SELECT 1 FROM bills INNER JOIN bill_tenants ON bill_tenants.bill_id = bills.bill_id
      WHERE bills.state = ${state} AND bills.provider = ${owner}
    )
    ON CONFLICT (state) ${onConflict}`)
  if (result.meta.changes === 0) return false
  await forgetSnapshotEtags(db, state)
  return true
}

/**
 * Drop the snapshot ETags stored for a state's sessions, so the first pass of
 * its new owner reads each file in full, matching every bill to instances
 * again, rather than taking a 304 from an ETag stored the last time it owned
 * the state. Anything that changes a state's owner calls this.
 */
export async function forgetSnapshotEtags(db: Db, state: string): Promise<void> {
  await db.update(sessions).set({ snapshotEtag: null }).where(eq(sessions.state, state))
}

/**
 * For one release, then to be removed: each state that a provider's old env
 * var names (Provider.statesEnvKey, such as LIMS_STATES) and that has no row
 * gets one, under the claim's refusal rule, so a central that turned a
 * provider on that way keeps it with no steps. A refused state stays on
 * LegiScan, and with `reportRefusals` the refusal is logged. A provider that
 * isn't configured seeds nothing, since its env var alone never turned it on.
 * Returns whether it tried a write.
 */
async function seedFromEnv(env: Env, db: Db, owners: StateOwners, reportRefusals: boolean): Promise<boolean> {
  let tried = false
  for (const provider of PROVIDERS) {
    const key = provider.statesEnvKey
    if (!key || !providerConfigured(provider, env)) continue
    const value = env[key]
    const named = (typeof value === 'string' ? value : '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    for (const state of named) {
      if (owners.has(state) || (provider.states && !provider.states.includes(state))) continue
      tried = true
      const refusal = await trackedBills(db, state, DEFAULT_PROVIDER_ID)
      if (refusal.trackedBills > 0) {
        if (reportRefusals) await reportRefusedSeed(db, state, provider.id, key, refusal)
      } else if (await writeClaim(db, state, provider.id, DEFAULT_PROVIDER_ID, 'seed')) {
        console.log(`[state-providers] ${state} now syncs from ${provider.id}, seeded from ${key}. ` +
          `${key} can be removed now that the row exists.`)
      }
    }
  }
  return tried
}

/**
 * Log a refused seed. When the env var's provider has tracked bills in the
 * state as well, instances hold bills from both providers: a split state,
 * which no claim or seed can settle, so it is logged as an error for an
 * operator. Either way the state stays with its owner and keeps syncing.
 */
async function reportRefusedSeed(db: Db, state: string, providerId: string, key: string, refusal: ClaimRefusal): Promise<void> {
  const own = await trackedBills(db, state, providerId)
  if (own.trackedBills > 0) {
    console.error(`[state-providers] ${state} is split: ${refusal.owner} has ${refusal.trackedBills} tracked bills there ` +
      `(instances: ${refusal.instances.join(', ')}) and ${providerId} has ${own.trackedBills} ` +
      `(instances: ${own.instances.join(', ')}). Not seeding ${state} for ${providerId} from ${key}. ` +
      `${state} stays on ${refusal.owner}, and an operator needs to move one provider's bills off it.`)
    return
  }
  console.warn(`[state-providers] not seeding ${state} for ${providerId} from ${key}: ` +
    `${refusal.owner} has ${refusal.trackedBills} tracked bills there (instances: ${refusal.instances.join(', ')}). ` +
    `${state} stays on ${refusal.owner} until a cutover moves them.`)
}
