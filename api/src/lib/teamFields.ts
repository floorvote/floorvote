import { and, inArray, isNotNull, sql, type SQL } from 'drizzle-orm'
import { billCustomFieldValues, bills, customFieldDefinitions, officialPositions, teamEvents } from '../db/schema'
import { chunk } from './chunk'
import { nowDb } from './dbTime'
import { FIELD_CHANGED, teamValueText, type FieldChangedMetadata } from '../../../shared/teamFields'
import type { ReplacedTeamValue } from '../../../shared/companionGroups'
import type { AppDb } from '../types'
import { groupedNewestTextDate, pickLead } from './groupLead'

/**
 * Team fields (see **Team field** in CONTEXT.md): the official position,
 * priority, custom field values, triage, and the AI analysis (team summary
 * and tags) a team keeps per bill. A companion group shares them.
 *
 * Each value stays stored on the bill where it was set. A read resolves it
 * across the bill's group to the member where it was set most recently, so
 * setting a value on any member's page sets the group's, and splitting the
 * group gives each bill back its own with no data migration. Clearing a value
 * clears it on every member, since an older value on a companion would
 * otherwise come back.
 *
 * "Most recently set" is the later timestamp: a position's or custom field's
 * `updated_at`, a priority's `priority_set_at`, an analysis's
 * `ai_processed_at`, a triage's `triaged_at`. A value with no timestamp is the
 * oldest, and a tie goes to the larger bill id, so every member's page reads
 * the same one.
 *
 * The analysis (team summary and tags) is the group's lead bill's (see
 * **Lead bill** in CONTEXT.md and lib/groupLead.ts): the bill furthest along,
 * then the one with the newest text, then the lowest bill number, tracked or
 * not. So the group's summary is of the bill that has moved furthest, and it
 * changes only when the lead does or the lead is analyzed again, never because
 * another member was. While the lead has no analysis yet, the group reads the
 * one it would have read before leads: among the members with an analysis,
 * those with a match type first, and the most recent of those (#554).
 * Migration 0113's `group_tags` triggers apply the same rule.
 */

type BillValues = {
  id: string
  /** The lead's fields (lib/groupLead.ts), which decide whose analysis a group shows. */
  billNumber: string
  statusRank: number
  /** The bill's newest text date, read only for a bill in a group. */
  newestTextDate: string | null
  /** Whether the bill is tracked (a match type), which decides whose analysis a group shows while its lead has none. */
  matchType: 'keyword' | 'manual' | null
  priority: 'high' | 'medium' | 'low' | null
  prioritySetAt: string | null
  tenantSummary: string | null
  tags: string
  aiProcessedAt: string | null
  triagedAt: string | null
  triagedBy: string | null
}
type PositionValue = { billId: string; position: string; setBy: string; updatedAt: string }
type CustomFieldValue = { billId: string; fieldId: string; value: string; setBy: string; updatedAt: string }

/** Every team field value stored on some bills, as read from the database. */
export type TeamValueRows = { bills: BillValues[]; positions: PositionValue[]; customFields: CustomFieldValue[] }

/** A group's team field values, each the one set most recently on any member (the analysis the lead's), or null. */
export type GroupTeamValues = {
  position: PositionValue | null
  priority: { billId: string; priority: 'high' | 'medium' | 'low'; setAt: string | null } | null
  customFields: Map<string, CustomFieldValue>
  analysis: { billId: string; tenantSummary: string | null; tags: string[]; aiProcessedAt: string | null } | null
  triaged: { billId: string; triagedAt: string; triagedBy: string | null } | null
  /** The group's lead bill (lib/groupLead.ts), or null for no members. Its analysis is `analysis` once it has one. */
  leadBillId: string | null
}

const billValueColumns = {
  id: bills.id,
  billNumber: bills.billNumber,
  statusRank: bills.statusRank,
  newestTextDate: groupedNewestTextDate(bills),
  matchType: bills.matchType,
  priority: bills.priority,
  prioritySetAt: bills.prioritySetAt,
  tenantSummary: bills.tenantSummary,
  tags: bills.tags,
  aiProcessedAt: bills.aiProcessedAt,
  triagedAt: bills.triagedAt,
  triagedBy: bills.triagedBy,
}

/** The row set most recently: the later timestamp, none being oldest, ties to the larger bill id. */
export function mostRecent<T extends { billId: string }>(rows: readonly T[], setAt: (row: T) => string | null): T | null {
  let best: T | null = null
  for (const row of rows) {
    if (best === null) { best = row; continue }
    const a = setAt(row) ?? ''
    const b = setAt(best) ?? ''
    if (a > b || (a === b && row.billId > best.billId)) best = row
  }
  return best
}

/** Every team field value stored on these bills. */
export async function readTeamValueRows(db: AppDb, billIds: readonly string[]): Promise<TeamValueRows> {
  const out: TeamValueRows = { bills: [], positions: [], customFields: [] }
  for (const part of chunk([...new Set(billIds)], 90)) {
    out.bills.push(...await db.select(billValueColumns).from(bills).where(inArray(bills.id, part)).all())
    out.positions.push(...await db.select({
      billId: officialPositions.billId, position: officialPositions.position, setBy: officialPositions.setBy, updatedAt: officialPositions.updatedAt,
    }).from(officialPositions).where(inArray(officialPositions.billId, part)).all())
    out.customFields.push(...await db.select({
      billId: billCustomFieldValues.billId, fieldId: billCustomFieldValues.fieldId, value: billCustomFieldValues.value,
      setBy: billCustomFieldValues.setBy, updatedAt: billCustomFieldValues.updatedAt,
    }).from(billCustomFieldValues).where(inArray(billCustomFieldValues.billId, part)).all())
  }
  return out
}

/** The team field values of a group of these members, from rows that include theirs. */
export function resolveTeamValues(rows: TeamValueRows, members: ReadonlySet<string>): GroupTeamValues {
  const memberBills = rows.bills.filter(b => members.has(b.id)).map(b => ({ ...b, billId: b.id }))
  const priority = mostRecent(memberBills.filter(b => b.priority !== null), b => b.prioritySetAt)
  const hasAnalysis = (b: BillValues) => b.aiProcessedAt !== null || b.tenantSummary !== null || b.tags !== '[]'
  const lead = pickLead(memberBills)
  const analyzed = memberBills.filter(hasAnalysis)
  const trackedAnalyzed = analyzed.filter(b => b.matchType !== null)
  const analysis = lead && hasAnalysis(lead) ? lead : mostRecent(trackedAnalyzed.length > 0 ? trackedAnalyzed : analyzed, b => b.aiProcessedAt)
  const triaged = mostRecent(memberBills.filter(b => b.triagedAt !== null), b => b.triagedAt)
  const customFields = new Map<string, CustomFieldValue>()
  const byField = new Map<string, CustomFieldValue[]>()
  for (const v of rows.customFields) {
    if (members.has(v.billId)) byField.set(v.fieldId, [...(byField.get(v.fieldId) ?? []), v])
  }
  for (const [fieldId, values] of byField) customFields.set(fieldId, mostRecent(values, v => v.updatedAt)!)
  return {
    position: mostRecent(rows.positions.filter(p => members.has(p.billId)), p => p.updatedAt),
    priority: priority ? { billId: priority.id, priority: priority.priority!, setAt: priority.prioritySetAt } : null,
    customFields,
    analysis: analysis
      ? { billId: analysis.id, tenantSummary: analysis.tenantSummary, tags: parseTags(analysis.tags), aiProcessedAt: analysis.aiProcessedAt }
      : null,
    triaged: triaged ? { billId: triaged.id, triagedAt: triaged.triagedAt!, triagedBy: triaged.triagedBy } : null,
    leadBillId: lead?.id ?? null,
  }
}

/**
 * The team field values each of these bills reads: its group's, or its own
 * for a bill in no group. A bill that doesn't exist reads none.
 */
export async function loadTeamValuesOf(db: AppDb, billIds: readonly string[]): Promise<Map<string, GroupTeamValues>> {
  const keyOf = new Map<string, string | null>()
  for (const part of chunk([...new Set(billIds)], 90)) {
    for (const r of await db.select({ id: bills.id, groupKey: bills.groupKey }).from(bills).where(inArray(bills.id, part)).all()) {
      keyOf.set(r.id, r.groupKey)
    }
  }
  const membersOf = new Map<string, Set<string>>()
  const keys = [...new Set([...keyOf.values()].filter((k): k is string => k !== null))]
  for (const part of chunk(keys, 90)) {
    for (const r of await db.select({ id: bills.id, groupKey: bills.groupKey }).from(bills)
      .where(and(isNotNull(bills.groupKey), inArray(bills.groupKey, part))).all()) {
      const set = membersOf.get(r.groupKey!) ?? new Set<string>()
      membersOf.set(r.groupKey!, set.add(r.id))
    }
  }
  const memberIds = new Set([...keyOf.keys(), ...[...membersOf.values()].flatMap(s => [...s])])
  const rows = await readTeamValueRows(db, [...memberIds])
  const out = new Map<string, GroupTeamValues>()
  for (const [id, key] of keyOf) {
    out.set(id, resolveTeamValues(rows, key === null ? new Set([id]) : (membersOf.get(key) ?? new Set([id]))))
  }
  return out
}

/** The team field values one bill reads: its group's, or its own. */
export async function loadGroupTeamValues(db: AppDb, billId: string): Promise<GroupTeamValues> {
  return (await loadTeamValuesOf(db, [billId])).get(billId)
    ?? { position: null, priority: null, customFields: new Map(), analysis: null, triaged: null, leadBillId: null }
}

/**
 * The bill is untriaged and so is every bill in its group: triaging,
 * prioritizing, or dismissing any member triages the group. For the outer
 * query's `bills` row. A bill in no group has a NULL key, which matches no
 * companion.
 */
export function groupUntriaged(of: BillsTable = bills): SQL {
  return sql`(${of.triagedAt} IS NULL AND NOT EXISTS (SELECT 1 FROM bills t WHERE t.group_key = ${of.groupKey} AND t.triaged_at IS NOT NULL))`
}

// ── Filtering by a group's current value ────────────────────────────────────
//
// A filter on a team field matches a group through the member holding the
// group's current value, never through a value a newer one replaced, so these
// predicates mirror `mostRecent` and `resolveTeamValues` above: the later
// timestamp wins, no timestamp is the oldest, and a tie goes to the larger bill
// id. Each takes the bills table the predicate tests, the real one or an alias
// of it, since the bill list tests every member of a group in turn.

/** A bills table or an alias of it. */
export type BillsTable = typeof bills

/**
 * Position (or custom field) rows from `official_positions p` and `bill_custom_field_values p`, with their bill
 * as `me`, hold the group's current value: none for the same field was set more recently by another member.
 */
export function holdsGroupValue(table: 'official_positions' | 'bill_custom_field_values'): SQL {
  // The field is correlated with the row's own, not bound again, so a custom field filter binds its id once.
  const sameField = table === 'bill_custom_field_values' ? sql` AND q.field_id = p.field_id` : sql``
  return sql`NOT EXISTS (SELECT 1 FROM ${sql.raw(table)} q JOIN bills g ON g.id = q.bill_id
      WHERE g.group_key = me.group_key${sameField}
        AND (q.updated_at > p.updated_at OR (q.updated_at = p.updated_at AND q.bill_id > p.bill_id)))`
}

/**
 * `of` is a bill in a group whose current value is held by one of `held`, a
 * subquery of bill ids: the holder itself, or any bill sharing its group. A
 * team value is the whole group's, so every bill in the group meets a filter
 * on it, which is what lets "Passed and high priority" find a group whose
 * Passed bill isn't the one the priority was set on. Both halves start from
 * `held` through an index, so a rare value still starts from its own rows.
 */
export function inGroupOfHeld(of: BillsTable, held: SQL): SQL {
  return sql`(${of.id} IN ${held} OR ${of.groupKey} IN (SELECT hb.group_key FROM bills hb WHERE hb.group_key IS NOT NULL AND hb.id IN ${held}))`
}

/**
 * The bills holding the group's current position, among those whose position is
 * one of `values` (any position when `values` is empty). A subquery of bill
 * ids, for `bills.id IN`, so a selective filter can start from the positions.
 */
export function heldPositionOf(values: readonly string[]): SQL {
  const among = values.length > 0 ? sql` AND p.position IN (${sql.join(values.map(v => sql`${v}`), sql`, `)})` : sql``
  return sql`(SELECT p.bill_id FROM official_positions p JOIN bills me ON me.id = p.bill_id
    WHERE ${holdsGroupValue('official_positions')}${among})`
}

/** Bills whose group has no position at all, as a condition on `of`. */
export function groupHasNoPosition(of: BillsTable): SQL {
  return sql`(${of.id} NOT IN (SELECT bill_id FROM official_positions)
    AND (${of.groupKey} IS NULL OR ${of.groupKey} NOT IN (SELECT me.group_key FROM official_positions p JOIN bills me ON me.id = p.bill_id WHERE me.group_key IS NOT NULL)))`
}

/**
 * The bills holding the group's current value of one custom field, among those
 * whose stored value meets `valueCondition` over `p.value` (any value when
 * undefined). A subquery of bill ids, for `bills.id IN`.
 */
export function heldCustomFieldOf(fieldId: string, valueCondition?: SQL): SQL {
  return sql`(SELECT p.bill_id FROM bill_custom_field_values p JOIN bills me ON me.id = p.bill_id
    WHERE p.field_id = ${fieldId}${valueCondition ? sql` AND ${valueCondition}` : sql``}
      AND ${holdsGroupValue('bill_custom_field_values')})`
}

/** `of` has a priority and it is its group's current one: no other member has one set more recently. */
export function holdsGroupPriority(of: BillsTable): SQL {
  return sql`(${of.priority} IS NOT NULL AND (${of.groupKey} IS NULL OR NOT EXISTS (SELECT 1 FROM bills g WHERE g.group_key = ${of.groupKey} AND g.priority IS NOT NULL
    AND (COALESCE(g.priority_set_at, '') > COALESCE(${of.prioritySetAt}, '')
      OR (COALESCE(g.priority_set_at, '') = COALESCE(${of.prioritySetAt}, '') AND g.id > ${of.id})))))`
}

/** Some bill in `of`'s group has a priority, `of`'s own included: the group is prioritized. The opposite of `groupHasNoPriority`. */
export function groupHasPriority(of: BillsTable): SQL {
  return sql`(${of.priority} IS NOT NULL OR (${of.groupKey} IS NOT NULL AND EXISTS (SELECT 1 FROM bills g WHERE g.group_key = ${of.groupKey} AND g.priority IS NOT NULL)))`
}

/**
 * The priority each of these companion groups currently has: the one set most
 * recently on any member (`holdsGroupPriority`'s rule, so the later
 * `priority_set_at` wins, none being oldest, and a tie goes to the larger bill
 * id). A group none of whose members has one is left out. For rows of a feed,
 * digest, or calendar, which read it once per page of rows, so every row of a
 * group wears the group's priority whichever member it was set on. Read apart
 * from the rows' own query, so a correlated subquery never sits in a query
 * that sorts (the feed's plan must not need a temp B-tree).
 */
export async function loadGroupPriorities(db: AppDb, groupKeys: ReadonlyArray<string | null | undefined>): Promise<Map<string, 'high' | 'medium' | 'low'>> {
  const rows: Array<{ billId: string; groupKey: string; priority: 'high' | 'medium' | 'low'; setAt: string | null }> = []
  for (const part of chunk([...new Set(groupKeys.filter((k): k is string => !!k))], 90)) {
    for (const r of await db.select({ billId: bills.id, groupKey: bills.groupKey, priority: bills.priority, setAt: bills.prioritySetAt })
      .from(bills).where(and(inArray(bills.groupKey, part), isNotNull(bills.priority))).all()) {
      rows.push({ billId: r.billId, groupKey: r.groupKey!, priority: r.priority!, setAt: r.setAt })
    }
  }
  const out = new Map<string, 'high' | 'medium' | 'low'>()
  for (const key of new Set(rows.map(r => r.groupKey))) {
    const holder = mostRecent(rows.filter(r => r.groupKey === key), r => r.setAt)
    if (holder) out.set(key, holder.priority)
  }
  return out
}

/** The priority a row of a bill wears: its group's when the bill is in one (`loadGroupPriorities`), else its own. */
export function priorityWorn(bill: { priority: 'high' | 'medium' | 'low' | null; groupKey: string | null }, groupPriorities: ReadonlyMap<string, 'high' | 'medium' | 'low'>): 'high' | 'medium' | 'low' | null {
  return bill.groupKey === null ? bill.priority : (groupPriorities.get(bill.groupKey) ?? null)
}

/** No bill in `of`'s group has a priority. */
export function groupHasNoPriority(of: BillsTable): SQL {
  return sql`(${of.priority} IS NULL AND (${of.groupKey} IS NULL OR NOT EXISTS (SELECT 1 FROM bills g WHERE g.group_key = ${of.groupKey} AND g.priority IS NOT NULL)))`
}

// ── Recording changes ───────────────────────────────────────────────────────

/** A team field set on one bill: the group's value before and after. */
export type FieldChange = FieldChangedMetadata & { billId: string }

/**
 * Record each change that changed something as a structured team event on
 * the bill where it was set, by the person who made it. The analysis's tags are
 * not recorded: the bill's comment thread shows only changes people made.
 */
export async function recordFieldChanges(db: AppDb, changes: readonly FieldChange[], actorUserId: string): Promise<void> {
  const now = nowDb()
  const events = changes.filter(c => !sameValue(c.old, c.new)).map(({ billId, ...change }) => {
    const metadata: FieldChangedMetadata = {
      field: change.field,
      ...(change.fieldId !== undefined ? { fieldId: change.fieldId } : {}),
      label: change.label,
      old: change.old,
      new: change.new,
    }
    return { id: crypto.randomUUID(), billId, type: FIELD_CHANGED, actorUserId, metadata: JSON.stringify(metadata), createdAt: now }
  })
  // One JSON parameter per statement, so a bulk edit of many bills stays
  // under D1's parameter limit. In order, so rowid follows the changes.
  for (const part of chunk(events, 200)) {
    await db.insert(teamEvents).select(sql`SELECT json_extract(e.value, '$.id'), json_extract(e.value, '$.billId'), json_extract(e.value, '$.type'),
        json_extract(e.value, '$.actorUserId'), json_extract(e.value, '$.metadata'), json_extract(e.value, '$.createdAt')
      FROM json_each(${JSON.stringify(part)}) e ORDER BY e.key`)
  }
}

function sameValue(a: string | null, b: string | null): boolean {
  return a === b
}

// ── Grouping ────────────────────────────────────────────────────────────────

type FieldDef = { id: string; name: string; type: string; displayOrder: number }

/** Every custom field's name and type, for naming the values grouping replaces. */
export async function loadFieldDefs(db: AppDb): Promise<FieldDef[]> {
  return db.select({ id: customFieldDefinitions.id, name: customFieldDefinitions.name, type: customFieldDefinitions.type, displayOrder: customFieldDefinitions.displayOrder })
    .from(customFieldDefinitions).all()
}

/**
 * The values a group forming from these parts replaced: each part (an old
 * group, or a bill that was in none) whose value for a field differs from the
 * one the new group reads, which is the most recently set across all of them.
 * Position, then priority, then custom fields in their display order. The AI
 * analysis is left out: no one set it, and identical bills analyzed apart
 * nearly always differ in wording.
 */
export function replacedTeamValues(
  rows: TeamValueRows,
  parts: ReadonlyArray<readonly string[]>,
  defs: readonly FieldDef[],
  billNumberOf: (billId: string) => string,
): ReplacedTeamValue[] {
  const winner = resolveTeamValues(rows, new Set(parts.flat()))
  const own = parts.map(part => resolveTeamValues(rows, new Set(part)))
  const out: ReplacedTeamValue[] = []
  const add = (
    head: Pick<ReplacedTeamValue, 'field' | 'fieldId' | 'label'>,
    pick: (v: GroupTeamValues) => { billId: string; raw: string } | null,
    text: (raw: string) => string,
  ) => {
    const w = pick(winner)
    if (!w) return
    const losers = own.map(pick).filter((v): v is { billId: string; raw: string } => v !== null && v.billId !== w.billId && v.raw !== w.raw)
    for (const v of losers.sort((a, b) => billNumberOf(a.billId).localeCompare(billNumberOf(b.billId), 'en', { numeric: true }))) {
      out.push({
        ...head,
        billId: v.billId,
        billNumber: billNumberOf(v.billId),
        value: text(v.raw),
        replacedBy: { billId: w.billId, billNumber: billNumberOf(w.billId), value: text(w.raw) },
      })
    }
  }
  add({ field: 'position', label: 'position' }, v => v.position && { billId: v.position.billId, raw: v.position.position }, raw => teamValueText('position', raw))
  add({ field: 'priority', label: 'priority' }, v => v.priority && { billId: v.priority.billId, raw: v.priority.priority }, raw => teamValueText('priority', raw))
  const ordered = [...defs].sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name))
  for (const def of ordered) {
    add(
      { field: 'customField', fieldId: def.id, label: def.name },
      v => { const c = v.customFields.get(def.id); return c ? { billId: c.billId, raw: c.value } : null },
      raw => teamValueText('customField', raw, def.type),
    )
  }
  return out
}

/**
 * A guard for the grouping recompute's write: true while the team field
 * values stored on these bills are still exactly `rows`, which the recompute
 * read to list what the grouping replaced. JSON parameters keep any number of
 * bills under D1's parameter limit.
 */
export function teamValuesUnchanged(billIds: readonly string[], rows: TeamValueRows): SQL {
  const ids = JSON.stringify(billIds)
  const billSnap = JSON.stringify(rows.bills.map(b => [b.id, b.priority, b.prioritySetAt]))
  const positionSnap = JSON.stringify(rows.positions.map(p => [p.billId, p.position, p.updatedAt]))
  const customSnap = JSON.stringify(rows.customFields.map(c => [c.billId, c.fieldId, c.value, c.updatedAt]))
  return sql`(SELECT COUNT(*) FROM bills b, json_each(${billSnap}) r
      WHERE b.id = json_extract(r.value, '$[0]') AND b.priority IS json_extract(r.value, '$[1]') AND b.priority_set_at IS json_extract(r.value, '$[2]')) = ${rows.bills.length}
    AND (SELECT COUNT(*) FROM official_positions p WHERE p.bill_id IN (SELECT value FROM json_each(${ids}))) = ${rows.positions.length}
    AND (SELECT COUNT(*) FROM official_positions p, json_each(${positionSnap}) r
      WHERE p.bill_id = json_extract(r.value, '$[0]') AND p.position = json_extract(r.value, '$[1]') AND p.updated_at = json_extract(r.value, '$[2]')) = ${rows.positions.length}
    AND (SELECT COUNT(*) FROM bill_custom_field_values v WHERE v.bill_id IN (SELECT value FROM json_each(${ids}))) = ${rows.customFields.length}
    AND (SELECT COUNT(*) FROM bill_custom_field_values v, json_each(${customSnap}) r
      WHERE v.bill_id = json_extract(r.value, '$[0]') AND v.field_id = json_extract(r.value, '$[1]')
        AND v.value = json_extract(r.value, '$[2]') AND v.updated_at = json_extract(r.value, '$[3]')) = ${rows.customFields.length}`
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}
