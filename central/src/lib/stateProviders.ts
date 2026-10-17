import { and, asc, countDistinct, eq, isNotNull, sql, type SQL } from 'drizzle-orm'
import { bills, billTenants, sessions, stateProviders } from '../db/schema'
import { DEFAULT_PROVIDER_ID } from '../providers'
import type { Db } from '../types'

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

/** Every state's owner, as a sync reads it: the table's rows, and nothing else. */
export async function loadStateOwners(db: Db): Promise<StateOwners> {
  const rows = await db.select({ state: stateProviders.state, provider: stateProviders.provider }).from(stateProviders).all()
  return new Map(rows.map(r => [r.state, r.provider]))
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
    if (await writeClaim(db, state, providerId, owner)) {
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
 * landing between the check and the write can't get past the rule. Returns
 * whether it wrote.
 */
async function writeClaim(db: Db, state: string, providerId: string, owner: string): Promise<boolean> {
  // Query builders rather than db.run, so the claim and the forgetting of
  // the state's snapshot ETags go in one batch and a claim can't land
  // without them. Drizzle inserts every state_providers column in schema
  // order: state, provider, status, previous_provider, claimed_at.
  const claim = db.insert(stateProviders).select(sql`
    SELECT ${state}, ${providerId}, 'active', ${owner}, datetime('now')
    WHERE NOT EXISTS (
      SELECT 1 FROM bills INNER JOIN bill_tenants ON bill_tenants.bill_id = bills.bill_id
      WHERE bills.state = ${state} AND bills.provider = ${owner}
    )`)
    .onConflictDoUpdate({
      target: stateProviders.state,
      set: {
        provider: sql`excluded.provider`, status: sql`excluded.status`,
        previousProvider: sql`excluded.previous_provider`, claimedAt: sql`excluded.claimed_at`,
      },
      setWhere: eq(stateProviders.provider, owner),
    })
  // Clears ETags only once the row names the new provider, so a refused claim forgets nothing.
  const forget = forgetEtags(db, state, sql`EXISTS (SELECT 1 FROM state_providers WHERE state = ${state} AND provider = ${providerId})`)
  const [result] = await db.batch([claim, forget])
  return result.meta.changes > 0
}

/**
 * Drop the snapshot ETags stored for a state's sessions, as one raw D1
 * statement that writes only while `condition` holds, so the first pass of its
 * new owner reads each file in full rather than taking a 304 from an ETag
 * stored the last time it owned the state. (A 304 pass still matches the
 * stored records to instances, so this keeps a new owner from trusting records
 * it stored long ago.) For a batch of raw statements that changes the state's
 * owner (lib/cutover.ts), as `writeClaim`'s batch does for a claim.
 */
export function forgetSnapshotEtagsStatement(db: Db, d1: D1Database, state: string, condition: SQL): D1PreparedStatement {
  const { sql: text, params } = forgetEtags(db, state, condition).toSQL()
  return d1.prepare(text).bind(...params)
}

function forgetEtags(db: Db, state: string, condition: SQL) {
  return db.update(sessions).set({ snapshotEtag: null })
    .where(and(eq(sessions.state, state), isNotNull(sessions.snapshotEtag), condition))
}
