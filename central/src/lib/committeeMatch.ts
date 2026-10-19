import { eq, sql } from 'drizzle-orm'
import { committeeRegistry, committees } from '../db/schema'
import type { Db } from '../types'

/**
 * Committee picks (#471). An instance picks committees in its Bill committees card, and a bill referred to one, or
 * pending in one, is fully analyzed there as a keyword match is: the same `match_type = 'keyword'` link, on every path
 * that matches keywords (the full pass, the keyword re-run, a seed), so it costs what a keyword match of the same bill
 * costs and no more.
 *
 * A bill's committees are its stored referrals and pending committee, which central has for every bill it has
 * fetched, and those its masterlist last action names ("Referred to Senate Judiciary"), which is all central knows of
 * a bill new to it, or of a later referral of a bill nobody tracks. No provider call is spent to learn them.
 */

/** A committee as inference reads it: its id, name, and chamber code (LegiScan's H, S, A, or J). */
export type CommitteeName = { committeeId: number; name: string; chamber: string }

/** The chamber an action names, by its code. */
const CHAMBER_WORDS: [RegExp, string][] = [[/\bsenate\b/i, 'S'], [/\bhouse\b/i, 'H'], [/\bassembly\b/i, 'A']]

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The committees an action refers the bill to, read from the action's text: each committee whose name follows a
 * "refer" as whole words, ignoring case. A name inside a longer one the action names is not one ("Health" in "Health
 * and Human Services"). Where the names fit committees of more than one chamber (each chamber's Judiciary), the chamber
 * the action names wins, and else the bill's own, from the first letter of its number. Reads nothing from an action
 * with no "refer".
 */
export function inferReferrals(lastAction: string | null | undefined, billNumber: string, committeeList: CommitteeName[]): number[] {
  if (!lastAction) return []
  const at = lastAction.search(/\brefer/i)
  if (at < 0) return []
  const text = lastAction.slice(at)
  const named = committeeList.filter(c => {
    const name = c.name.trim()
    return name !== '' && new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, 'i').test(text)
  })
  const longest = named.filter(c => !named.some(o =>
    o.name.trim().length > c.name.trim().length && o.name.toLowerCase().includes(c.name.trim().toLowerCase())))
  if (new Set(longest.map(c => c.chamber)).size <= 1) return longest.map(c => c.committeeId)
  const chamber = CHAMBER_WORDS.find(([re]) => re.test(text))?.[1] ?? billNumber.trim().charAt(0).toUpperCase()
  const inChamber = longest.filter(c => c.chamber === chamber)
  return (inChamber.length > 0 ? inChamber : longest).map(c => c.committeeId)
}

/** The committees each instance picked, by instance. An instance that picked none has no entry. */
export async function selectedCommittees(db: Db, tenantIds: string[]): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>()
  if (tenantIds.length === 0) return out
  const rows = await db.select({ tenantId: committeeRegistry.tenantId, committeeId: committeeRegistry.committeeId })
    .from(committeeRegistry)
    .where(sql`${committeeRegistry.tenantId} IN (SELECT value FROM json_each(${JSON.stringify(tenantIds)}))`).all()
  for (const r of rows) out.set(r.tenantId, (out.get(r.tenantId) ?? new Set()).add(r.committeeId))
  return out
}

/** Replace an instance's picks with `committeeIds`. An empty list clears them. */
export async function saveSelectedCommittees(db: Db, tenantId: string, committeeIds: number[]): Promise<void> {
  const ids = [...new Set(committeeIds)]
  const INSERT_CHUNK = 40
  const inserts = []
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    inserts.push(db.insert(committeeRegistry).values(ids.slice(i, i + INSERT_CHUNK).map(committeeId => ({ tenantId, committeeId }))))
  }
  await db.batch([db.delete(committeeRegistry).where(eq(committeeRegistry.tenantId, tenantId)), ...inserts])
}

/** Bill ids per statement, bound as one JSON list. */
const BILL_CHUNK = 1000

/**
 * Of `committeeIds`, the ones each bill is referred to or pending in, by bill id: from its stored referrals and
 * pending committee, and from the committees its last action refers it to (`inferReferrals`, against its state's
 * committees). A bill with none of them has no entry. Reads nothing when `committeeIds` is empty.
 */
export async function committeeHits(
  db: Db,
  billList: { billId: number; billNumber: string; lastAction: string | null | undefined; state: string }[],
  committeeIds: number[],
): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>()
  if (committeeIds.length === 0 || billList.length === 0) return out
  const picked = new Set(committeeIds)
  const add = (billId: number, committeeId: number) => out.set(billId, (out.get(billId) ?? new Set()).add(committeeId))
  const ids = JSON.stringify(committeeIds)

  for (let i = 0; i < billList.length; i += BILL_CHUNK) {
    const chunk = JSON.stringify(billList.slice(i, i + BILL_CHUNK).map(b => b.billId))
    const rows = await db.all<{ billId: number; committeeId: number }>(sql`
      SELECT bill_id AS billId, committee_id AS committeeId FROM bill_referrals
      WHERE bill_id IN (SELECT value FROM json_each(${chunk})) AND committee_id IN (SELECT value FROM json_each(${ids}))
      UNION
      SELECT bill_id AS billId, pending_committee_id AS committeeId FROM bills
      WHERE bill_id IN (SELECT value FROM json_each(${chunk})) AND pending_committee_id IN (SELECT value FROM json_each(${ids}))`)
    for (const r of rows) add(r.billId, r.committeeId)
  }

  const states = [...new Set(billList.filter(b => b.lastAction).map(b => b.state))]
  if (states.length > 0) {
    const named = await db.select({ committeeId: committees.committeeId, name: committees.name, chamber: committees.chamber, state: committees.state })
      .from(committees).where(sql`${committees.state} IN (SELECT value FROM json_each(${JSON.stringify(states)}))`).all()
    const byState = new Map<string, CommitteeName[]>()
    for (const c of named) byState.set(c.state, [...(byState.get(c.state) ?? []), c])
    for (const b of billList) {
      for (const committeeId of inferReferrals(b.lastAction, b.billNumber, byState.get(b.state) ?? [])) {
        if (picked.has(committeeId)) add(b.billId, committeeId)
      }
    }
  }
  return out
}

/** Whether a bill's committee hits include one the instance picked. */
export function inPickedCommittee(hits: Map<number, Set<number>>, billId: number, picks: Set<number> | undefined): boolean {
  if (!picks || picks.size === 0) return false
  const mine = hits.get(billId)
  if (!mine) return false
  for (const id of mine) if (picks.has(id)) return true
  return false
}
