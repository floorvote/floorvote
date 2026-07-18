import { Hono } from 'hono'
import { eq, and, inArray, isNull, ne } from 'drizzle-orm'
import { requireAdmin } from '../../middleware/auth'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, officialPositions, comments, notes, feedEvents, billTexts,
} from '../../db/schema'
import type { AppEnv } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { backfillCalendar, parseLegiScanId } from '../../lib/calendarBackfill'
import { nowDb } from '../../lib/dbTime'

// Latch a bill as triaged. Idempotent: the isNull guard means only the first
// triage (dismiss or priority-set) records the actor/timestamp, so re-triaging
// preserves the original attribution. Shared by the dismiss and priority routes.
async function latchTriaged(db: ReturnType<typeof getDb>, id: string, userId: string): Promise<void> {
  await db.update(bills)
    .set({ triagedAt: nowDb(), triagedBy: userId })
    .where(and(eq(bills.id, id), isNull(bills.triagedAt)))
}

export function registerDraftRoutes(router: Hono<AppEnv>) {
  // DELETE /bills/:id — admin only
  router.delete('/:id', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const { id } = c.req.param()
    const bill = await db.select({ id: bills.id, isDraft: bills.isDraft }).from(bills).where(eq(bills.id, id)).get()
    if (!bill) return c.json({ error: 'Bill not found' }, 404)
    if (!bill.isDraft) return c.json({ error: 'Only draft bills can be deleted' }, 403)

    const [v, p, cm, nt] = await Promise.all([
      db.select({ id: memberVotes.id }).from(memberVotes).where(eq(memberVotes.billId, id)).get(),
      db.select({ billId: officialPositions.billId }).from(officialPositions).where(eq(officialPositions.billId, id)).get(),
      db.select({ id: comments.id }).from(comments).where(and(eq(comments.billId, id), isNull(comments.deletedAt))).get(),
      db.select({ id: notes.id }).from(notes).where(and(eq(notes.billId, id), ne(notes.content, ''))).get(),
    ])
    if (v || p || cm || nt) return c.json({ error: 'This draft has engagement; unlink or merge it into a filed bill instead.' }, 409)

    await db.batch([
      db.delete(feedEvents).where(eq(feedEvents.billId, id)),
      db.delete(comments).where(eq(comments.billId, id)),
      db.delete(officialPositions).where(eq(officialPositions.billId, id)),
      db.delete(memberVotes).where(eq(memberVotes.billId, id)),
      db.delete(notes).where(eq(notes.billId, id)),
      db.delete(billTexts).where(eq(billTexts.billId, id)),
      db.delete(bills).where(eq(bills.id, id)),
    ])
    return new Response(null, { status: 204 })
  })

  // POST /bills/draft — create a pre-filed (draft) bill (admin/owner only)
  router.post('/draft', requireAdmin, async (c) => {
    const db = getDb(c.env.DB)
    const body = await c.req.json<{
      billNumber?: string; title?: string; summary?: string; sponsor?: string; text?: string; state?: string
    }>().catch(() => ({} as Record<string, string>))
    const title = body.title?.trim()
    if (!title) return c.json({ error: 'title is required' }, 400)

    const id = crypto.randomUUID()
    const user = c.get('user')
    const state = (body.state?.trim() || c.env.STATE || '').toUpperCase()
    const billNumber = body.billNumber?.trim() || 'DRAFT'

    await db.insert(bills).values({
      id,
      externalId: null,
      billNumber,
      title,
      state,
      matchType: 'manual',
      isDraft: true,
      draftText: body.text?.trim() || null,
      tenantSummary: body.summary?.trim() || null,
      sponsor: body.sponsor?.trim() || null,
      addedBy: user.id,
    })

    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'bill_added',
      billId: id,
      userId: user.id,
      metadata: JSON.stringify({ draft: true, billNumber, title }),
    })

    return c.json({ id, billNumber, title, isDraft: true }, 201)
  })

  // POST /bills/:id/link — merge a draft into a filed bill (admin/owner only). :id is the DRAFT.
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

    // Heterogeneous update/delete queries collected for db.batch(); type as the element array.
    const ops: Parameters<typeof db.batch>[0][number][] = []
    ops.push(db.update(comments).set({ billId: filedBillId }).where(eq(comments.billId, draftId)))
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
    ops.push(db.update(feedEvents).set({ billId: filedBillId }).where(eq(feedEvents.billId, draftId)))
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
      title?: string; sponsor?: string; summary?: string; text?: string
    }>().catch(() => ({} as Record<string, string>))

    // Build update object — only include fields present in body
    const patch: Partial<typeof existing> = {}
    if ('title' in body) {
      const t = body.title?.trim()
      if (t) patch.title = t
      // empty title is silently ignored (cannot clear required field)
    }
    if ('sponsor' in body) patch.sponsor = body.sponsor?.trim() || null
    if ('summary' in body) patch.tenantSummary = body.summary?.trim() || null
    if ('text' in body) patch.draftText = body.text?.trim() || null

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
    await db.update(bills).set({ priority, updatedAt: nowDb() }).where(eq(bills.id, id))
    let promoted = false
    if (priority) {
      const userId = c.get('user').id
      // Setting a priority is an act of triage — latch the match as triaged so
      // clearing the priority later doesn't send it back to the New queue.
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
      const legiscanId = parseLegiScanId(row?.externalId)
      // Backfill hearings for this newly-prioritized bill (fire-and-forget).
      if (legiscanId !== null) c.executionCtx.waitUntil(backfillCalendar(c.env, [legiscanId]))
      // Promote a lightweight LegiScan stub to full tracking + AI (zero-cost on central;
      // the ingestor will make one getBill() call). Failures log but don't fail the request.
      if (legiscanId !== null && row?.matchType === null) {
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
