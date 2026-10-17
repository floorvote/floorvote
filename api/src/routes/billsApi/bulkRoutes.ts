import { Hono } from 'hono'
import { eq, and, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { bills, officialPositions, feedEvents, billCustomFieldValues, customFieldDefinitions } from '../../db/schema'
import type { AppEnv } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { backfillCalendar } from '../../lib/calendarBackfill'
import { isHandle, parseHandle } from '../../../../shared/billHandle'
import { nowDb } from '../../lib/dbTime'
import { billsAs, buildBillsFilter } from './query'
import { countGroups, matchingGroupKeys, newMatchGroupKeys, newMatchGroupsAmong } from './groupList'
import { getNewMatchMinRelevance } from '../../lib/newMatch'
import { parseBillFilter } from '../../../../shared/billFilter'
import { billFilterFromBulkBody, subjectCapError, type BulkFilterBody } from './filterRequest'
import { parseStoredMulti } from '../../../../shared/customFieldValues'
import { inGroupOf, inGroupsOf } from '../../lib/companionGroups'
import { loadTeamValuesOf, recordFieldChanges, type FieldChange } from '../../lib/teamFields'

// Cloudflare D1 rejects queries with >100 bound parameters. Chunk bulk operations
// below 100 to leave headroom for the extra SET/predicate params some queries add
// (e.g. .set({ triagedAt, triagedBy }) or newMatchWhere's matchType + relevance).
const BULK_CHUNK = 90

export function registerBulkRoutes(router: Hono<AppEnv>) {
  router.post('/bulk', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const currentUser = c.get('user')

    type BulkBody = {
      ids?: string[]
      filter?: BulkFilterBody
      priority?: string | null
      position?: string | null
      customFields?: Array<
        | { fieldId: string; value: string | null }
        | { fieldId: string; additions?: string[]; removals?: string[] }
      >
    }

    const body = await c.req.json<BulkBody>().catch(() => null)
    if (!body) return c.json({ error: 'Invalid body' }, 400)

    if (Array.isArray(body.ids) && body.ids.length === 0) {
      return c.json({ error: 'ids array must not be empty' }, 400)
    }
    const hasIds = Array.isArray(body.ids) && body.ids.length > 0
    const hasFilter = body.filter != null
    if (hasIds === hasFilter) {
      return c.json({ error: 'Provide exactly one of: ids or filter' }, 400)
    }

    const hasPriority = 'priority' in body
    const hasPosition = 'position' in body
    const hasCf = Array.isArray(body.customFields) && body.customFields.length > 0
    if (!hasPriority && !hasPosition && !hasCf) {
      return c.json({ error: 'No actions specified' }, 400)
    }

    const VALID_PRIORITIES = ['high', 'medium', 'low']
    if (hasPriority && body.priority !== null && !VALID_PRIORITIES.includes(body.priority!)) {
      return c.json({ error: 'priority must be high, medium, low, or null' }, 400)
    }

    // Resolve the bills to edit: one per companion group, named by its key bill.
    // The 1,000 cap counts groups. An edit of any bill in a group is the group's
    // (see lib/teamFields.ts), so the group's key bill stands for it.
    let billIds: string[]
    let selected: SQL | undefined
    if (hasIds) {
      billIds = body.ids!
    } else {
      // The filter is read as the list reads a query string, so the two select the same bills.
      const f = billFilterFromBulkBody(body.filter)
      // Same cap and message as GET /bills, checked before any write.
      const capError = subjectCapError(f)
      if (capError) return c.json(capError, 400)
      const filter = await buildBillsFilter(db, f, {
        userId: currentUser.id,
        newMatchMinRelevance: f.newMatches ? await getNewMatchMinRelevance(db) : 0,
      })
      selected = filter(billsAs('m'))
      // One more than the cap tells an over-cap selection from one at it.
      billIds = await matchingGroupKeys(db, selected, 1001)
    }

    if (billIds.length === 0) return c.json({ updated: 0 })
    if (billIds.length > 1000) {
      // The count is only for the message, so it is read only when the selection is refused.
      const n = hasIds ? billIds.length : await countGroups(db, selected)
      return c.json({ error: `Too many bills (${n}). Apply more filters to narrow down to 1,000 or fewer.` }, 400)
    }

    const now = nowDb()
    const count = billIds.length
    // Past this many bills, one event per bill would flood the feed. One bill-less
    // event names them all instead (metadata.billIds), so it belongs to no single bill.
    const isBulk = count > 10

    // Team fields (lib/teamFields.ts): each value is set on the selected bill,
    // the most recent in its companion group, so the whole group reads it. A
    // clear clears every member, so an older value on a companion doesn't come
    // back. `before` is what each selected bill's group read until now, for
    // the team events this edit records and for multi-select additions.
    const before = await loadTeamValuesOf(db, billIds)
    const changes: FieldChange[] = []

    // Apply priority
    if (hasPriority) {
      const priority = (body.priority ?? null) as 'high' | 'medium' | 'low' | null
      for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
        const part = billIds.slice(i, i + BULK_CHUNK)
        await db.update(bills)
          .set({ priority, prioritySetAt: now, updatedAt: now })
          .where(priority ? inArray(bills.id, part) : inGroupsOf(bills.id, part))
      }
      for (const billId of billIds) {
        changes.push({ billId, field: 'priority', label: 'priority', old: before.get(billId)?.priority?.priority ?? null, new: priority })
      }
      if (priority) {
        // Latch each newly-prioritized match as triaged (idempotent — first actor wins).
        for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
          await db.update(bills)
            .set({ triagedAt: now, triagedBy: currentUser.id })
            .where(and(inArray(bills.id, billIds.slice(i, i + BULK_CHUNK)), isNull(bills.triagedAt)))
        }
        if (!isBulk) {
          await db.insert(feedEvents).values(
            billIds.map(billId => ({
              id: crypto.randomUUID(),
              type: 'priority_set' as const,
              billId,
              userId: currentUser.id,
              metadata: JSON.stringify({ priority }),
            }))
          )
        } else {
          await db.insert(feedEvents).values({
            id: crypto.randomUUID(),
            type: 'priority_set' as const,
            billId: null,
            userId: currentUser.id,
            metadata: JSON.stringify({ priority, count, billIds }),
          })
        }
        // Fetch externalId + matchType once for both calendar backfill and promotion.
        // Chunked — billIds can be up to 1000, well over D1's 100-bound-param cap.
        const ext: { externalId: string | null; matchType: 'keyword' | 'manual' | null }[] = []
        for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
          const rows = await db.select({ externalId: bills.externalId, matchType: bills.matchType })
            .from(bills).where(inArray(bills.id, billIds.slice(i, i + BULK_CHUNK))).all()
          ext.push(...rows)
        }
        const legiscanIds = ext
          .map(r => parseHandle(r.externalId))
          .filter((n): n is number => n !== null)
        // Backfill hearings for the newly-prioritized bills (fire-and-forget).
        c.executionCtx.waitUntil(backfillCalendar(c.env, legiscanIds))
        // Promote null-match LegiScan stubs to full tracking + AI in one central call.
        const promoteIds = ext
          .filter(r => r.matchType === null)
          .map(r => parseHandle(r.externalId))
          .filter((n): n is number => n !== null)
        // As in draftRoutes: promotion runs AI, which a demo must never do.
        if (promoteIds.length > 0 && c.env.DEMO_MODE !== 'true') {
          try {
            const res = await centralFetch(c.env, `/tenants/promote-bills/${c.env.TENANT_ID}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ billIds: promoteIds }),
            })
            if (!res.ok) console.error(`[bulk] promote-bills failed: ${res.status} ${await res.text().catch(() => '')}`)
          } catch (err) {
            console.error('[bulk] promote-bills error:', err)
          }
        }
      }
    }

    // Apply position
    if (hasPosition) {
      for (const billId of billIds) {
        changes.push({ billId, field: 'position', label: 'position', old: before.get(billId)?.position?.position ?? null, new: body.position ?? null })
      }
      if (body.position === null) {
        for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
          await db.delete(officialPositions).where(inGroupsOf(officialPositions.billId, billIds.slice(i, i + BULK_CHUNK)))
        }
      } else {
        const position = body.position!
        for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
          await db.batch(
            billIds.slice(i, i + BULK_CHUNK).map(billId =>
              db.insert(officialPositions)
                .values({ id: crypto.randomUUID(), billId, position, setBy: currentUser.id, createdAt: now, updatedAt: now })
                .onConflictDoUpdate({
                  target: officialPositions.billId,
                  set: { position, setBy: currentUser.id, updatedAt: now },
                })
            ) as unknown as Parameters<typeof db.batch>[0]
          )
        }
      }
      if (!isBulk) {
        await db.insert(feedEvents).values(
          billIds.map(billId => ({
            id: crypto.randomUUID(),
            type: 'position_set' as const,
            billId,
            userId: currentUser.id,
            metadata: JSON.stringify({ position: body.position }),
          }))
        )
      } else {
        await db.insert(feedEvents).values({
          id: crypto.randomUUID(),
          type: 'position_set' as const,
          billId: null,
          userId: currentUser.id,
          metadata: JSON.stringify({ position: body.position, count, billIds }),
        })
      }
    }

    // Apply custom fields
    if (hasCf) {
      const labelOf = new Map((await db.select({ id: customFieldDefinitions.id, name: customFieldDefinitions.name })
        .from(customFieldDefinitions).all()).map(d => [d.id, d.name]))
      for (const entry of body.customFields!) {
        const fieldId = entry.fieldId
        const isMultiOp = 'additions' in entry || 'removals' in entry
        const oldOf = (billId: string) => before.get(billId)?.customFields.get(fieldId)?.value ?? null
        const change = (billId: string, value: string | null) =>
          changes.push({ billId, field: 'customField', fieldId, label: labelOf.get(fieldId) ?? fieldId, old: oldOf(billId), new: value })

        if (isMultiOp) {
          const additions = ('additions' in entry ? entry.additions : undefined) ?? []
          const removals = ('removals' in entry ? entry.removals : undefined) ?? []
          if (additions.length === 0 && removals.length === 0) continue

          // Each bill's current value is its group's, so an addition keeps the
          // options a companion's value holds.
          const existingByBill = new Map(billIds.flatMap(billId => {
            const value = oldOf(billId)
            return value === null ? [] : [[billId, value] as const]
          }))

          const additionsSet = new Set(additions)
          const removalsSet = new Set(removals)

          for (let i = 0; i < billIds.length; i += 50) {
            const chunk = billIds.slice(i, i + 50)
            // Heterogeneous delete/insert queries collected for db.batch(); type as the
            // batch element type (BatchItem) so chained .where()/.onConflictDoUpdate() results fit.
            const ops: Parameters<typeof db.batch>[0][number][] = []
            for (const billId of chunk) {
              const raw = existingByBill.get(billId)
              let current: string[] = []
              if (raw) {
                try {
                  const parsed = JSON.parse(raw)
                  current = Array.isArray(parsed) ? parsed : [raw]
                } catch {
                  current = [raw]
                }
              }
              const next = [...new Set([...current, ...additions])].filter(v => !removalsSet.has(v))
              // Preserve insertion order: original existing first, then new additions
              const ordered: string[] = []
              for (const v of current) if (!removalsSet.has(v) && next.includes(v)) ordered.push(v)
              for (const v of additions) if (!ordered.includes(v) && next.includes(v)) ordered.push(v)

              if (ordered.length === 0) {
                change(billId, null)
                ops.push(db.delete(billCustomFieldValues).where(and(
                  inGroupOf(billCustomFieldValues.billId, billId),
                  eq(billCustomFieldValues.fieldId, fieldId),
                )))
              } else {
                const stored = JSON.stringify(ordered)
                change(billId, stored)
                ops.push(db.insert(billCustomFieldValues)
                  .values({ billId, fieldId, value: stored, setBy: currentUser.id, updatedAt: now })
                  .onConflictDoUpdate({
                    target: [billCustomFieldValues.billId, billCustomFieldValues.fieldId],
                    set: { value: stored, setBy: currentUser.id, updatedAt: now },
                  }))
              }
            }
            if (ops.length > 0) {
              await db.batch(ops as unknown as Parameters<typeof db.batch>[0])
            }
          }
          continue
        }

        const value = 'value' in entry ? entry.value : null
        for (const billId of billIds) change(billId, value)
        if (value === null) {
          for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
            await db.delete(billCustomFieldValues).where(
              and(
                inGroupsOf(billCustomFieldValues.billId, billIds.slice(i, i + BULK_CHUNK)),
                eq(billCustomFieldValues.fieldId, fieldId),
              )
            )
          }
        } else {
          for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
            await db.batch(
              billIds.slice(i, i + BULK_CHUNK).map(billId =>
                db.insert(billCustomFieldValues)
                  .values({ billId, fieldId, value, setBy: currentUser.id, updatedAt: now })
                  .onConflictDoUpdate({
                    target: [billCustomFieldValues.billId, billCustomFieldValues.fieldId],
                    set: { value, setBy: currentUser.id, updatedAt: now },
                  })
              ) as unknown as Parameters<typeof db.batch>[0]
            )
          }
        }
      }
    }

    // Only bills that exist: a selection by id may name one deleted since.
    await recordFieldChanges(db, changes.filter(ch => before.has(ch.billId)), currentUser.id)

    return c.json({ updated: count })
  })

  // POST /bills/bulk-dismiss — admin only. Batched "reviewed — no priority": stamps
  // triaged_at/by for the un-triaged keyword new-matches within the selection only.
  // Accepts the same { ids } | { filter } shape as /bulk. Idempotent and non-destructive.
  router.post('/bulk-dismiss', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const currentUser = c.get('user')

    type Body = { ids?: string[]; filter?: BulkFilterBody }

    const body = await c.req.json<Body>().catch(() => null)
    if (!body) return c.json({ error: 'Invalid body' }, 400)
    const hasIds = Array.isArray(body.ids) && body.ids.length > 0
    const hasFilter = body.filter != null
    if (hasIds === hasFilter) return c.json({ error: 'Provide exactly one of: ids or filter' }, 400)

    // Computed up front — the groups to dismiss are only those on the new-match queue,
    // even when the "New matches" chip (f.newMatches) is off but the dismiss action is
    // still available.
    const min = await getNewMatchMinRelevance(db)

    let toDismiss: string[]
    if (hasIds) {
      // The groups of the bills named that are on the new-match queue.
      toDismiss = await newMatchGroupsAmong(db, body.ids!, min)
    } else {
      // Read as POST /bulk reads it, and as the list reads a query string.
      const f = billFilterFromBulkBody(body.filter)
      // Same cap and message as GET /bills, checked before any write.
      const capError = subjectCapError(f)
      if (capError) return c.json(capError, 400)
      const filter = await buildBillsFilter(db, f, { userId: currentUser.id, newMatchMinRelevance: f.newMatches ? min : 0 })
      // One bill per group, named by its key bill: a group is dismissed as one. One statement, so the
      // groups the filter names (every group on a broad filter) never travel as a parameter.
      toDismiss = await newMatchGroupKeys(db, filter(billsAs('m')), min)
    }

    if (toDismiss.length === 0) return c.json({ dismissed: 0 })

    const now = nowDb()
    // Triaging any bill in a group triages the group (lib/teamFields.ts), so the
    // key bill is stamped. The UPDATE adds a few params on top of the inArray
    // list (triagedAt + triagedBy), which is why it's chunked at the shared
    // BULK_CHUNK rather than the raw 100-param cap.
    for (let i = 0; i < toDismiss.length; i += BULK_CHUNK) {
      await db.update(bills)
        .set({ triagedAt: now, triagedBy: currentUser.id })
        .where(inArray(bills.id, toDismiss.slice(i, i + BULK_CHUNK)))
    }
    return c.json({ dismissed: toDismiss.length })
  })

  // GET /bills/bulk-values — admin only; returns value distributions across matching bills
  // for pre-populating the bulk action bar. Must be before /:id to avoid param capture.
  router.get('/bulk-values', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const currentUser = c.get('user')
    const url = new URL(c.req.url)
    const params = url.searchParams

    // Resolve bill IDs — either explicit `ids` params or filter
    let billIds: string[]

    const explicitIds = params.getAll('ids')
    if (explicitIds.length > 0) {
      billIds = explicitIds
    } else {
      // The same parse as GET /bills, of the same query string.
      const f = parseBillFilter(params)
      // Same cap and message as GET /bills.
      const capError = subjectCapError(f)
      if (capError) return c.json(capError, 400)
      // This is the read that pre-populates the bulk-edit form's initial values, and it must agree with
      // the write that follows it.
      const filter = await buildBillsFilter(db, f, {
        userId: currentUser.id,
        newMatchMinRelevance: f.newMatches ? await getNewMatchMinRelevance(db) : 0,
      })

      // One bill per companion group, named by its key bill.
      billIds = await matchingGroupKeys(db, filter(billsAs('m')), 1000)
    }

    if (billIds.length === 0) {
      return c.json({ count: 0, priorities: {}, positions: {}, customFields: {}, multiCustomFields: {}, nullMatchCount: 0, newMatchCount: 0 })
    }

    // Each bill's team values are its group's, as the bulk-edit form edits them
    // (lib/teamFields.ts), so a group counts once with the values it reads.
    const teamValues = await loadTeamValuesOf(db, billIds)
    const priorityCounts: Record<string, number> = {}
    const positionCounts: Record<string, number> = {}
    for (const id of billIds) {
      const values = teamValues.get(id)
      if (!values) continue // a bill selected by id that no longer exists
      const priorityKey = values.priority?.priority ?? 'null'
      priorityCounts[priorityKey] = (priorityCounts[priorityKey] ?? 0) + 1
      // Bills without a position count as null
      const positionKey = values.position?.position ?? 'null'
      positionCounts[positionKey] = (positionCounts[positionKey] ?? 0) + 1
    }

    // Untracked stubs a bulk priority would promote, among the bills named (chunked for inArray safety).
    let nullMatchCount = 0
    for (let i = 0; i < billIds.length; i += BULK_CHUNK) {
      const rows = await db
        .select({ matchType: bills.matchType, externalId: bills.externalId })
        .from(bills)
        .where(inArray(bills.id, billIds.slice(i, i + BULK_CHUNK)))
        .all()
      for (const row of rows) if (row.matchType === null && isHandle(row.externalId)) nullMatchCount++
    }
    // New matches among the groups: a group is one when any bill in it is, and no bill in it is triaged.
    const newMatchCount = (await newMatchGroupsAmong(db, billIds, await getNewMatchMinRelevance(db))).length

    // Multi-select fields store a JSON array per bill, so their counts are tallied
    // per option (a bill can contribute to several options) and reported separately
    // from `cfCounts`, whose counts are expected to partition the selection.
    const multiFieldIds = new Set(
      (await db
        .select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.multiple, true))
        .all()
      ).map(r => r.id)
    )

    // Custom field values, each the group's current one
    const cfCounts: Record<string, Record<string, number>> = {}
    const multiCfCounts: Record<string, Record<string, number>> = {}
    for (const id of billIds) {
      for (const [fieldId, row] of teamValues.get(id)?.customFields ?? []) {
        if (multiFieldIds.has(fieldId)) {
          if (!multiCfCounts[fieldId]) multiCfCounts[fieldId] = {}
          for (const opt of parseStoredMulti(row.value)) {
            multiCfCounts[fieldId][opt] = (multiCfCounts[fieldId][opt] ?? 0) + 1
          }
          continue
        }
        if (!cfCounts[fieldId]) cfCounts[fieldId] = {}
        cfCounts[fieldId][row.value] = (cfCounts[fieldId][row.value] ?? 0) + 1
      }
    }

    // Back-fill null counts: the value counts of a field must sum to billIds.length, and any gap
    // is bills with no value for it. Multi-select fields are exempt — their per-option counts
    // overlap, so the client compares each option's count against `count` instead.
    for (const fieldId of Object.keys(cfCounts)) {
      const counted = Object.values(cfCounts[fieldId]).reduce((sum, n) => sum + n, 0)
      const missing = billIds.length - counted
      if (missing > 0) cfCounts[fieldId]['null'] = (cfCounts[fieldId]['null'] ?? 0) + missing
    }

    return c.json({
      count: billIds.length,
      priorities: priorityCounts,
      positions: positionCounts,
      customFields: cfCounts,
      multiCustomFields: multiCfCounts,
      nullMatchCount,
      newMatchCount,
    })
  })
}
