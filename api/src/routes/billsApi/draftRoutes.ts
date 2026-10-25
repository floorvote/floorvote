import { Hono } from 'hono'
import { eq, and, inArray, isNull, ne, max } from 'drizzle-orm'
import type { Context } from 'hono'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, officialPositions, comments, notes, feedEvents, billTexts,
  billCustomFieldValues, calendarEventBills, notifications, billMutes, teamEvents,
} from '../../db/schema'
import type { AppEnv } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { backfillCalendar } from '../../lib/calendarBackfill'
import { parseHandle } from '../../../../shared/billHandle'
import { nowDb } from '../../lib/dbTime'
import { nextDraftNumber, findNumberCollision } from '../../lib/draftNumber'
import { resolveCustomFieldValues } from '../../lib/customFieldValues'
import { inGroupOf } from '../../lib/companionGroups'
import { isPulledByGroup } from '../../lib/companionAnalysis'
import { loadGroupTeamValues, recordFieldChanges } from '../../lib/teamFields'
import { parseStoredItems } from '../../lib/claimSources'
import { pruneClaimSources } from '../../lib/claimResolution'
import { deleteDrafts } from '../../lib/draftDelete'

// Latch a bill as triaged. Idempotent: the isNull guard means only the first
// triage (dismiss or priority-set) records the actor/timestamp, so re-triaging
// preserves the original attribution. Shared by the dismiss and priority routes.
// Stored on this bill only: a companion group reads as triaged when any member
// is (groupUntriaged in lib/teamFields.ts), and a split restores each bill's own.
async function latchTriaged(db: ReturnType<typeof getDb>, id: string, userId: string): Promise<void> {
  await db.update(bills)
    .set({ triagedAt: nowDb(), triagedBy: userId })
    .where(and(eq(bills.id, id), isNull(bills.triagedAt)))
}

export function registerDraftRoutes(router: Hono<AppEnv>) {
  // DELETE /bills/:id — admin only. A draft with engagement answers 409 unless `?includeEngaged=1` says the
  // admin confirmed deleting it with its votes, positions, comments, and notes (lib/draftDelete.ts).
  router.delete('/:id', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const flag = c.req.query('includeEngaged')
    const includeEngaged = flag === '1' || flag === 'true'
    const { skipped } = await deleteDrafts(db, [id], { includeEngaged, attachments: c.env.ATTACHMENTS_BUCKET })
    const refusal = skipped[0]?.reason
    if (refusal === 'not_found') return c.json({ error: 'Bill not found' }, 404)
    if (refusal === 'not_draft') return c.json({ error: 'Only draft bills can be deleted' }, 403)
    if (refusal === 'engaged') {
      return c.json({ error: 'This draft has votes, comments, notes, or a position. Link it to its filed bill instead, or delete it with includeEngaged=1.' }, 409)
    }
    // The batch kept the draft for a reason we could not read back: not deleted, and not known to be engaged.
    if (refusal === 'error') return c.json({ error: 'internal_error' }, 500)

    return new Response(null, { status: 204 })
  })

  // POST /bills/draft — create a pre-filed (draft) bill (admin/owner only)
  router.post('/draft', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const body = await c.req.json<{
      billNumber?: string; title?: string | null; summary?: string; sponsor?: string
      text?: string; state?: string; year?: number; customFields?: unknown
    }>().catch(() => ({} as Record<string, string>))
    // A draft may be untitled: a request often has a number months before it
    // has a title. bills.title is NOT NULL, so an untitled draft stores '' and
    // display falls back to "Untitled draft" (shared/billTitle.ts).
    const title = typeof body.title === 'string' ? body.title.trim() : ''

    const id = crypto.randomUUID()
    const user = c.get('user')
    const state = (body.state?.trim() || c.env.STATE || '').toUpperCase()
    // A multi-state tenant has no c.env.STATE fallback, so an omitted body.state
    // resolves to '' here. billUrl() requires a state, so a stateless draft can
    // never get a canonical URL — reject rather than silently creating one.
    // A single-state tenant always has c.env.STATE set, so this never fires there.
    if (!state) {
      return c.json({ error: 'More than one state is tracked here. Include a state when creating a draft.' }, 400)
    }
    // Custom field values sent with the create request, in the same format and
    // under the same rules as the bill page's PUT /bills/:id/custom-fields.
    // No current client sends them (the bill page edits them in place), but the
    // field stays accepted. Validated before anything is written, so a bad
    // value leaves no draft behind.
    const cf = 'customFields' in body ? body.customFields : undefined
    if (cf !== undefined && cf !== null && (typeof cf !== 'object' || Array.isArray(cf))) {
      return c.json({ error: 'customFields must be an object of field ID to value' }, 400)
    }
    const resolved = await resolveCustomFieldValues(db, (cf ?? {}) as Record<string, unknown>)
    if (!resolved.ok) return c.json(resolved.error, 400)

    const year = Number.isInteger(body.year) ? Number(body.year) : await defaultDraftYear(c, db, state)
    const billNumber = body.billNumber?.trim() || await nextDraftNumber(db, state)

    const collision = await findNumberCollision(db, { state, year, billNumber })
    if (collision) {
      return c.json({ error: `${billNumber} is already used by another ${state} bill in ${year}.` }, 409)
    }

    // One timestamp for the draft and its values: they are set "at creation".
    const now = nowDb()
    // The draft, its custom field values, and its feed event in one batch:
    // either all are written or none are. A null (or empty multi-select) value
    // means "not set", which on a new draft is simply no row.
    const ops: Parameters<typeof db.batch>[0][number][] = [
      db.insert(bills).values({
        id,
        externalId: null,
        billNumber,
        title,
        state,
        yearStart: year,
        yearEnd: year,
        matchType: 'manual',
        isDraft: true,
        draftText: body.text?.trim() || null,
        tenantSummary: body.summary?.trim() || null,
        sponsor: body.sponsor?.trim() || null,
        addedBy: user.id,
        createdAt: now,
        updatedAt: now,
      }),
    ]
    for (const { fieldId, value } of resolved.values) {
      if (value === null) continue
      ops.push(db.insert(billCustomFieldValues).values({ billId: id, fieldId, value, setBy: user.id, updatedAt: now }))
    }
    ops.push(db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'bill_added',
      billId: id,
      userId: user.id,
      metadata: JSON.stringify({ draft: true, billNumber, title }),
    }))
    await db.batch(ops as unknown as Parameters<typeof db.batch>[0])

    return c.json({ id, billNumber, title, year, isDraft: true }, 201)
  })

  // POST /bills/:id/link — link a draft to its filed bill (admin/owner only). :id is the DRAFT.
  router.post('/:id/link', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const draftId = c.req.param('id')
    const { filedBillId } = await c.req.json<{ filedBillId?: string }>().catch(() => ({} as { filedBillId?: string }))
    if (!filedBillId) return c.json({ error: 'filedBillId is required' }, 400)
    if (filedBillId === draftId) return c.json({ error: 'cannot link a bill to itself' }, 400)

    const [draft, filed] = await Promise.all([
      db.select().from(bills).where(eq(bills.id, draftId)).get(),
      db.select().from(bills).where(eq(bills.id, filedBillId)).get(),
    ])
    if (!draft || !draft.isDraft) return c.json({ error: 'draft not found' }, 404)
    if (!filed) return c.json({ error: 'filed bill not found' }, 404)
    if (filed.isDraft) return c.json({ error: 'target must be a filed (non-draft) bill' }, 400)

    const filedHasPosition = await db.select({ billId: officialPositions.billId })
      .from(officialPositions).where(eq(officialPositions.billId, filedBillId)).get()
    const filedNoteUserIds = (await db.select({ userId: notes.userId })
      .from(notes).where(eq(notes.billId, filedBillId)).all()).map(r => r.userId)
    const filedVoteUserIds = (await db.select({ userId: memberVotes.userId })
      .from(memberVotes).where(eq(memberVotes.billId, filedBillId)).all()).map(r => r.userId)
    const filedFieldIds = (await db.select({ fieldId: billCustomFieldValues.fieldId })
      .from(billCustomFieldValues).where(eq(billCustomFieldValues.billId, filedBillId)).all()).map(r => r.fieldId)
    const filedEventIds = (await db.select({ eventId: calendarEventBills.eventId })
      .from(calendarEventBills).where(eq(calendarEventBills.billId, filedBillId)).all()).map(r => r.eventId)
    const filedMuteUserIds = (await db.select({ userId: billMutes.userId })
      .from(billMutes).where(eq(billMutes.billId, filedBillId)).all()).map(r => r.userId)

    // Heterogeneous update/delete queries collected for db.batch(); type as the element array.
    const ops: Parameters<typeof db.batch>[0][number][] = []
    ops.push(db.update(comments).set({ billId: filedBillId }).where(eq(comments.billId, draftId)))
    // Notifications name their bill and cascade-delete with it, so they follow their comments.
    ops.push(db.update(notifications).set({ billId: filedBillId }).where(eq(notifications.billId, draftId)))
    if (filedHasPosition) {
      ops.push(db.delete(officialPositions).where(eq(officialPositions.billId, draftId)))
    } else {
      ops.push(db.update(officialPositions).set({ billId: filedBillId }).where(eq(officialPositions.billId, draftId)))
    }
    if (filedNoteUserIds.length) {
      ops.push(db.delete(notes).where(and(eq(notes.billId, draftId), inArray(notes.userId, filedNoteUserIds))))
    }
    ops.push(db.update(notes).set({ billId: filedBillId }).where(eq(notes.billId, draftId)))
    if (filedVoteUserIds.length) {
      ops.push(db.delete(memberVotes).where(and(eq(memberVotes.billId, draftId), inArray(memberVotes.userId, filedVoteUserIds))))
    }
    ops.push(db.update(memberVotes).set({ billId: filedBillId }).where(eq(memberVotes.billId, draftId)))
    // A member who muted the draft stays muted on the filed bill. Mutes cascade-delete with the draft.
    if (filedMuteUserIds.length) {
      ops.push(db.delete(billMutes).where(and(eq(billMutes.billId, draftId), inArray(billMutes.userId, filedMuteUserIds))))
    }
    ops.push(db.update(billMutes).set({ billId: filedBillId }).where(eq(billMutes.billId, draftId)))
    // Custom field values cascade-delete with the draft, so they must move first.
    // Filed bill wins on a shared field; set_by/updated_at are kept as-is.
    if (filedFieldIds.length) {
      ops.push(db.delete(billCustomFieldValues).where(and(eq(billCustomFieldValues.billId, draftId), inArray(billCustomFieldValues.fieldId, filedFieldIds))))
    }
    ops.push(db.update(billCustomFieldValues).set({ billId: filedBillId }).where(eq(billCustomFieldValues.billId, draftId)))
    // calendar_event_bills has no FK, so unmoved rows would orphan on the dead draft id.
    if (filedEventIds.length) {
      ops.push(db.delete(calendarEventBills).where(and(eq(calendarEventBills.billId, draftId), inArray(calendarEventBills.eventId, filedEventIds))))
    }
    ops.push(db.update(calendarEventBills).set({ billId: filedBillId }).where(eq(calendarEventBills.billId, draftId)))
    ops.push(db.update(feedEvents).set({ billId: filedBillId }).where(eq(feedEvents.billId, draftId)))
    // Field-change history cascade-deletes with the draft, so it must move first.
    ops.push(db.update(teamEvents).set({ billId: filedBillId }).where(eq(teamEvents.billId, draftId)))
    ops.push(db.delete(bills).where(eq(bills.id, draftId)))

    await db.batch(ops as unknown as Parameters<typeof db.batch>[0])

    return c.json({ ok: true, filedBillId, mergedFrom: draftId })
  })

  // PATCH /bills/:id/draft — edit an existing draft's fields (admin only)
  router.patch('/:id/draft', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const existing = await db.select().from(bills).where(eq(bills.id, id)).get()
    if (!existing) return c.json({ error: 'Not found' }, 404)
    if (!existing.isDraft) return c.json({ error: 'not a draft bill' }, 400)

    const body = await c.req.json<{
      title?: string | null; sponsor?: string; summary?: string; text?: string
      billNumber?: string; year?: number; state?: string
    }>().catch(() => ({} as Record<string, string>))

    // Build update object — only include fields present in body
    const patch: Partial<typeof existing> = {}
    // A blank title clears it: a draft may be untitled (stored as '', shown as
    // "Untitled draft"). Filed bills never reach here — the isDraft guard above
    // 400s them — so a source title can't be blanked through this endpoint.
    if ('title' in body) patch.title = typeof body.title === 'string' ? body.title.trim() : ''
    if ('sponsor' in body) patch.sponsor = body.sponsor?.trim() || null
    if ('summary' in body) {
      patch.tenantSummary = body.summary?.trim() || null
      // Claim sources are quotes behind claims in the summary, so an edit keeps
      // only those whose claim is still in it.
      if (existing.claimSources !== null) {
        patch.claimSources = JSON.stringify(pruneClaimSources(parseStoredItems(existing.claimSources) ?? [], patch.tenantSummary))
      }
    }
    if ('text' in body) patch.draftText = body.text?.trim() || null

    // An omitted state leaves the row alone — including a legacy '', which
    // migration 0070 deliberately did not guess a value for. A state that IS
    // sent must be usable: billUrl() needs one, so a draft whose state is
    // cleared could never get a canonical /STATE/YEAR/NUMBER URL. Same
    // reasoning as the create guard in POST /bills/draft above.
    let nextState = existing.state
    if ('state' in body) {
      const s = body.state?.trim().toUpperCase() ?? ''
      if (!s) {
        return c.json({ error: 'A draft without a state cannot have a canonical URL. Include a state when editing a draft.' }, 400)
      }
      nextState = s
    }

    const nextNumber = 'billNumber' in body ? (body.billNumber?.trim() || existing.billNumber) : existing.billNumber
    const nextYear = Number.isInteger(body.year) ? Number(body.year) : existing.yearStart
    // State is part of the uniqueness triple (state, year, billNumber), so a
    // state-only change has to re-run the collision check too — moving a draft
    // into a state that already numbers a bill this way is the same ambiguity
    // as renumbering it within one.
    if (nextNumber !== existing.billNumber || nextYear !== existing.yearStart || nextState !== existing.state) {
      const collision = await findNumberCollision(db, {
        state: nextState, year: nextYear as number, billNumber: nextNumber, excludeId: id,
      })
      if (collision) {
        return c.json({ error: `${nextNumber} is already used by another ${nextState} bill in ${nextYear}.` }, 409)
      }
      patch.billNumber = nextNumber
      patch.yearStart = nextYear as number
      patch.yearEnd = nextYear as number
      if (nextState !== existing.state) patch.state = nextState
    }

    if (Object.keys(patch).length > 0) {
      await db.update(bills).set(patch).where(eq(bills.id, id))
    }

    // Re-fetch to return current state
    const updated = await db.select().from(bills).where(eq(bills.id, id)).get()
    return c.json({
      id,
      title: updated!.title,
      sponsor: updated!.sponsor ?? null,
      summary: updated!.tenantSummary ?? null,
      text: updated!.draftText ?? null,
      billNumber: updated!.billNumber,
      year: updated!.yearStart,
      state: updated!.state,
      isDraft: true,
    })
  })

  // PATCH /bills/:id/priority — admin only
  router.patch('/:id/priority', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const body = await c.req.json<{ priority?: string | null }>().catch(() => ({} as { priority?: string | null }))
    if (!('priority' in body)) {
      return c.json({ error: 'priority is required' }, 400)
    }
    const VALID_PRIORITIES = ['high', 'medium', 'low']
    if (body.priority !== null && !VALID_PRIORITIES.includes(body.priority as string)) {
      return c.json({ error: 'priority must be high, medium, low, or null' }, 400)
    }
    const priority = (body.priority ?? null) as 'high' | 'medium' | 'low' | null
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Bill not found' }, 404)
    const userId = c.get('user').id
    // Set on this bill, the most recent in its companion group, so the group
    // reads it. Cleared on every member, so an older priority on a companion
    // doesn't come back.
    const old = (await loadGroupTeamValues(db, id)).priority?.priority ?? null
    const now = nowDb()
    await db.update(bills)
      .set({ priority, prioritySetAt: now, updatedAt: now })
      .where(priority ? eq(bills.id, id) : inGroupOf(bills.id, id))
    await recordFieldChanges(db, [{ billId: id, field: 'priority', label: 'priority', old, new: priority }], userId)
    let promoted = false
    if (priority) {
      // Setting a priority is an act of triage — latch the match as triaged so
      // clearing the priority later doesn't send it back to the New queue. The
      // latch on this bill triages its whole companion group.
      await latchTriaged(db, id, userId)
      await db.insert(feedEvents).values({
        id: crypto.randomUUID(),
        type: 'priority_set',
        billId: id,
        userId,
        metadata: JSON.stringify({ priority }),
      })
      const row = await db.select({ externalId: bills.externalId, matchType: bills.matchType })
        .from(bills).where(eq(bills.id, id)).get()
      const legiscanId = parseHandle(row?.externalId)
      // Backfill hearings for this newly-prioritized bill (fire-and-forget).
      if (legiscanId !== null) c.executionCtx.waitUntil(backfillCalendar(c.env, [legiscanId]))
      // Promote a monitored LegiScan bill to full tracking + AI (zero-cost on central;
      // the ingestor will make one getBill() call). Failures log but don't fail the request.
      // Promotion means "fetch text and run AI", which a demo must never do —
      // see the demo guard in queue/processor.ts. `promoted` stays false so the
      // response doesn't claim analysis is coming when none is.
      //
      // Nor does a pulled companion promote (a bill with no match type whose
      // companion group holds a tracked bill): it is analyzed through its group
      // and never tracked (CONTEXT.md), and the priority set above is already
      // the group's. Since #945 the feed's no-priority row and lone card can name
      // one as their bill, so a priority set from there lands on it.
      if (legiscanId !== null && row?.matchType === null && c.env.DEMO_MODE !== 'true' && !await isPulledByGroup(db, id)) {
        promoted = true
        try {
          const res = await centralFetch(c.env, `/tenants/promote-bill/${c.env.TENANT_ID}/${legiscanId}`, { method: 'POST' })
          if (!res.ok) console.error(`[priority] promote failed: ${res.status} ${await res.text().catch(() => '')}`)
        } catch (err) {
          console.error('[priority] promote error:', err)
        }
      }
    }
    return c.json({ priority, promoted })
  })

  // PATCH /bills/:id/triage-dismiss — admin only. Resolves a new keyword-match bill
  // as "reviewed, no priority". Org-shared and non-destructive: the bill stays a
  // tracked keyword bill everywhere else and still receives status updates — it just
  // leaves the "New matches" worklist. Idempotent: only the first dismiss records the
  // actor/timestamp (the isNull guard preserves the original attribution).
  router.patch('/:id/triage-dismiss', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const bill = await db.select({ id: bills.id }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Bill not found' }, 404)
    await latchTriaged(db, id, c.get('user').id)
    return c.json({ ok: true })
  })
}

/** The year a new draft should default to. Drafting happens most often during
 *  the off-season, so once the current session is sine die the sensible default
 *  is the NEXT session, not the one that just ended.
 *
 *  A central outage must not block creating a draft — a slightly wrong year is
 *  editable, a 500 is not — so this falls back to the tenant's own newest filed
 *  year and logs.
 *
 *  Exported so GET /bills/draft-defaults (lookupRoutes.ts, which must register
 *  before GET /:id) and this file's own POST /draft can both call it without a
 *  circular import: lookupRoutes.ts imports from here, not the other way. */
export async function defaultDraftYear(
  c: Context<AppEnv>,
  db: ReturnType<typeof getDb>,
  state: string,
): Promise<number> {
  const thisYear = new Date().getUTCFullYear()
  try {
    const res = await centralFetch(c.env, `/tenants/current-session/${state}`)
    if (res.ok) {
      const s = await res.json<{ yearStart: number; yearEnd: number; sineDie: boolean }>()
      if (s.sineDie) return s.yearEnd + 1
      return Math.min(Math.max(thisYear, s.yearStart), s.yearEnd)
    }
    console.error(`[draft-defaults] central returned ${res.status}`)
  } catch (err) {
    console.error('[draft-defaults] central unreachable:', err)
  }
  const row = await db
    .select({ yearEnd: max(bills.yearEnd) })
    .from(bills)
    .where(and(eq(bills.isDraft, false), eq(bills.state, state)))
    .get()
  return row?.yearEnd ?? thisYear
}
