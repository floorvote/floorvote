import { sql } from 'drizzle-orm'
import { people } from '../db/schema'
import type { MeasurePerson } from '../providers'
import type { Db } from '../types'

type PersonRow = typeof people.$inferInsert & { peopleId: number }

/**
 * The `people` row for a provider's person record. Shared by the bill ingest
 * (sponsors embedded in getBill) and the weekly dataset load (people/*.json),
 * so both write the same columns the same way. bio_json is left out on purpose:
 * only the bulk seeder and getSessionPeople populate it, and an upsert from
 * here must not clear it.
 */
export function personRow(p: Partial<MeasurePerson> & { people_id: number }, fallbackStateId: number | null): PersonRow {
  return {
    peopleId:      p.people_id,
    personHash:    p.person_hash ?? null,
    stateId:       p.state_id ?? fallbackStateId ?? null,
    partyId:       p.party_id ?? null,
    party:         p.party || null,
    roleId:        p.role_id ?? null,
    role:          p.role || null,
    name:          p.name || String(p.people_id),
    firstName:     p.first_name ?? null,
    middleName:    p.middle_name ?? null,
    lastName:      p.last_name ?? null,
    suffix:        p.suffix ?? null,
    nickname:      p.nickname ?? null,
    district:      p.district || null,
    ftmEid:        p.ftm_eid ?? null,
    votesmartId:   p.votesmart_id ?? null,
    opensecretsId: p.opensecrets_id ?? null,
    knowwhoPid:    p.knowwho_pid ?? null,
    ballotpedia:   p.ballotpedia ?? null,
    bioguideId:    p.bioguide_id ?? null,
  }
}

/** D1 binds at most 100 parameters per statement, and a person row has 20. */
const ROWS_PER_STATEMENT = 4

/**
 * Insert the people central has no row for, and leave existing rows alone.
 * For a source that can be older than the ingest's getBill data, such as the
 * weekly bulk dataset, so it fills gaps without overwriting newer details.
 * One lookup (ids as a single JSON parameter), then multi-row inserts in one
 * batch. Returns how many statements ran, so a caller working to a
 * per-invocation query budget can count them.
 */
export async function insertMissingPeople(db: Db, rows: PersonRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const existing = await db.all<{ people_id: number }>(sql`
    SELECT people_id FROM people
    WHERE people_id IN (SELECT value FROM json_each(${JSON.stringify(rows.map(r => r.peopleId))}))`)
  const have = new Set(existing.map(r => r.people_id))
  const missing = rows.filter(r => !have.has(r.peopleId))
  if (missing.length === 0) return 1
  const stmts = []
  for (let i = 0; i < missing.length; i += ROWS_PER_STATEMENT) {
    stmts.push(db.insert(people).values(missing.slice(i, i + ROWS_PER_STATEMENT)).onConflictDoNothing())
  }
  await db.batch(stmts as [typeof stmts[number], ...typeof stmts])
  return 1 + stmts.length
}
