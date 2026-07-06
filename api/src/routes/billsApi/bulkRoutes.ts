import { Hono } from 'hono'
import { eq, and, inArray } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import { bills, officialPositions, feedEvents, billCustomFieldValues } from '../../db/schema'
import type { AppEnv } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { backfillCalendar, parseLegiScanId } from '../../lib/calendarBackfill'
import { nowDb } from '../../lib/dbTime'
import { buildBillsWhere } from './query'
import { getNewMatchMinRelevance } from '../../lib/newMatch'

export function registerBulkRoutes(router: Hono<AppEnv>) {
  router.post('/bulk', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const currentUser = c.get('user')

    type BulkBody = {
      ids?: string[]
      filter?: {
        status?: string[]
        priority?: string[]
        position?: string[]
        session?: string[]
        year?: string[]
        state?: string[]
        tag?: string[]
        q?: string
        minRelevance?: string
        myBills?: string
        unvoted?: string
        newMatches?: string
        cf?: Record<string, string[]>
      }
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

    // Resolve bill IDs
    let billIds: string[]
    if (hasIds) {
      billIds = body.ids!
    } else {
      const f = body.filter!
      const where = await buildBillsWhere(db, {
        statuses: f.status ?? [],
        priorities: f.priority ?? [],
        positionValues: f.position ?? [],
        sessions: f.session ?? [],
        years: f.year ?? [],
        states: f.state ?? [],
        tagFilters: f.tag ?? [],
        q: f.q,
        minRelevance: f.minRelevance,
        myBillsParam: f.myBills != null ? String(f.myBills) : undefined,
        unvoted: f.unvoted,
        newMatches: f.newMatches,
        newMatchMinRelevance: (f.newMatches === '1' || f.newMatches === 'true') ? await getNewMatchMinRelevance(db) : 0,
        cfParamMap: f.cf ?? {},
        userId: currentUser.id,
      })
      const rows = await db.select({ id: bills.id }).from(bills).where(where).all()
      billIds = rows.map(r => r.id)
    }

    if (billIds.length === 0) return c.json({ updated: 0 })
    if (billIds.length > 1000) {
      return c.json({ error: `Too many bills (${billIds.length}). Apply more filters to narrow down to 1,000 or fewer.` }, 400)
    }

    const now = nowDb()
    const count = billIds.length
    const isBulk = count > 10

    // Apply priority
    if (hasPriority) {
      const priority = (body.priority ?? null) as 'high' | 'medium' | 'low' | null
      for (let i = 0; i < billIds.length; i += 100) {
        await db.update(bills)
          .set({ priority, updatedAt: now })
          .where(inArray(bills.id, billIds.slice(i, i + 100)))
      }
      if (priority) {
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
            billId: billIds[0],
            userId: currentUser.id,
            metadata: JSON.stringify({ priority, isBulk: true, count }),
          })
        }
        // Fetch externalId + matchType once for both calendar backfill and promotion.
        const ext = await db.select({ externalId: bills.externalId, matchType: bills.matchType })
          .from(bills).where(inArray(bills.id, billIds)).all()
        const legiscanIds = ext
          .map(r => parseLegiScanId(r.externalId))
          .filter((n): n is number => n !== null)
        // Backfill hearings for the newly-prioritized bills (fire-and-forget).
        c.executionCtx.waitUntil(backfillCalendar(c.env, legiscanIds))
        // Promote null-match LegiScan stubs to full tracking + AI in one central call.
        const promoteIds = ext
          .filter(r => r.matchType === null)
          .map(r => parseLegiScanId(r.externalId))
          .filter((n): n is number => n !== null)
        if (promoteIds.length > 0) {
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
      if (body.position === null) {
        for (let i = 0; i < billIds.length; i += 100) {
          await db.delete(officialPositions).where(inArray(officialPositions.billId, billIds.slice(i, i + 100)))
        }
      } else {
        const position = body.position!
        for (let i = 0; i < billIds.length; i += 100) {
          await db.batch(
            billIds.slice(i, i + 100).map(billId =>
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
          billId: billIds[0],
          userId: currentUser.id,
          metadata: JSON.stringify({ position: body.position, isBulk: true, count }),
        })
      }
    }

    // Apply custom fields
    if (hasCf) {
      for (const entry of body.customFields!) {
        const fieldId = entry.fieldId
        const isMultiOp = 'additions' in entry || 'removals' in entry

        if (isMultiOp) {
          const additions = ('additions' in entry ? entry.additions : undefined) ?? []
          const removals = ('removals' in entry ? entry.removals : undefined) ?? []
          if (additions.length === 0 && removals.length === 0) continue

          // Read existing values for all affected bills
          const existingRows = await db
            .select({ billId: billCustomFieldValues.billId, value: billCustomFieldValues.value })
            .from(billCustomFieldValues)
            .where(and(
              inArray(billCustomFieldValues.billId, billIds),
              eq(billCustomFieldValues.fieldId, fieldId),
            ))
            .all()
          const existingByBill = new Map(existingRows.map(r => [r.billId, r.value]))

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
                ops.push(db.delete(billCustomFieldValues).where(and(
                  eq(billCustomFieldValues.billId, billId),
                  eq(billCustomFieldValues.fieldId, fieldId),
                )))
              } else {
                const stored = JSON.stringify(ordered)
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
        if (value === null) {
          for (let i = 0; i < billIds.length; i += 100) {
            await db.delete(billCustomFieldValues).where(
              and(
                inArray(billCustomFieldValues.billId, billIds.slice(i, i + 100)),
                eq(billCustomFieldValues.fieldId, fieldId),
              )
            )
          }
        } else {
          for (let i = 0; i < billIds.length; i += 100) {
            await db.batch(
              billIds.slice(i, i + 100).map(billId =>
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

    return c.json({ updated: count })
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
      const statuses = params.getAll('status')
      const priorities = params.getAll('priority')
      const positionValues = params.getAll('position')
      const sessions = params.getAll('session')
      const years = params.getAll('year')
      const states = params.getAll('state')
      const tagFilters = params.getAll('tag')
      const q = params.get('q') ?? undefined
      const minRelevance = params.get('minRelevance') ?? undefined
      const myBillsParam = params.get('myBills') ?? undefined
      const unvoted = params.get('unvoted') ?? undefined
      const newMatchesParam = params.get('newMatches') ?? undefined

      const cfParamMap: Record<string, string[]> = {}
      for (const [key, value] of params) {
        if (key.startsWith('cf_')) {
          const fieldId = key.slice(3)
          ;(cfParamMap[fieldId] ??= []).push(value)
        }
      }

      const where = await buildBillsWhere(db, {
        statuses, priorities, positionValues, sessions, years, states, tagFilters,
        q, minRelevance, myBillsParam, unvoted,
        newMatches: newMatchesParam,
        newMatchMinRelevance: (newMatchesParam === '1' || newMatchesParam === 'true') ? await getNewMatchMinRelevance(db) : 0,
        cfParamMap, userId: currentUser.id,
      })

      const rows = await db
        .select({ id: bills.id })
        .from(bills)
        .where(where)
        .limit(1000)
        .all()
      billIds = rows.map(r => r.id)
    }

    if (billIds.length === 0) {
      return c.json({ count: 0, priorities: {}, positions: {}, customFields: {}, nullMatchCount: 0 })
    }

    // Fetch priority + position in chunks of 100 for inArray safety
    const priorityCounts: Record<string, number> = {}
    const positionCounts: Record<string, number> = {}
    let nullMatchCount = 0

    for (let i = 0; i < billIds.length; i += 100) {
      const chunk = billIds.slice(i, i + 100)

      const billRows = await db
        .select({ id: bills.id, priority: bills.priority, externalId: bills.externalId, matchType: bills.matchType })
        .from(bills)
        .where(inArray(bills.id, chunk))
        .all()

      for (const row of billRows) {
        const key = row.priority ?? 'null'
        priorityCounts[key] = (priorityCounts[key] ?? 0) + 1
        if (row.matchType === null && parseLegiScanId(row.externalId) !== null) nullMatchCount++
      }

      const posRows = await db
        .select({ billId: officialPositions.billId, position: officialPositions.position })
        .from(officialPositions)
        .where(inArray(officialPositions.billId, chunk))
        .all()

      // Bills without a position row count as null
      const positionedBillIds = new Set(posRows.map(r => r.billId))
      for (const id of chunk) {
        if (!positionedBillIds.has(id)) {
          positionCounts['null'] = (positionCounts['null'] ?? 0) + 1
        }
      }
      for (const row of posRows) {
        positionCounts[row.position] = (positionCounts[row.position] ?? 0) + 1
      }
    }

    // Fetch custom field values
    const cfCounts: Record<string, Record<string, number>> = {}
    for (let i = 0; i < billIds.length; i += 100) {
      const chunk = billIds.slice(i, i + 100)
      const cfRows = await db
        .select({
          billId: billCustomFieldValues.billId,
          fieldId: billCustomFieldValues.fieldId,
          value: billCustomFieldValues.value,
        })
        .from(billCustomFieldValues)
        .where(inArray(billCustomFieldValues.billId, chunk))
        .all()

      // Track which fields have a value for each bill in this chunk
      const fieldBillsSeen: Record<string, Set<string>> = {}
      for (const row of cfRows) {
        if (!cfCounts[row.fieldId]) cfCounts[row.fieldId] = {}
        if (!fieldBillsSeen[row.fieldId]) fieldBillsSeen[row.fieldId] = new Set()
        fieldBillsSeen[row.fieldId].add(row.billId)
        cfCounts[row.fieldId][row.value] = (cfCounts[row.fieldId][row.value] ?? 0) + 1
      }

      // Bills with no value for a field count as null — only for fields seen in this chunk
      for (const fieldId of Object.keys(fieldBillsSeen)) {
        const missing = chunk.length - fieldBillsSeen[fieldId].size
        if (missing > 0) {
          cfCounts[fieldId]['null'] = (cfCounts[fieldId]['null'] ?? 0) + missing
        }
      }
    }

    // Back-fill null counts for chunks where a field had no rows at all:
    // sum of all value counts per field must equal billIds.length; any gap = unset bills
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
      nullMatchCount,
    })
  })
}
