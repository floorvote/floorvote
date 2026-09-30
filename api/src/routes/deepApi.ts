import { Hono } from 'hono'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { getDb } from '../db/client'
import { bills, calendarEventBills, calendarEvents, deepAnalyses } from '../db/schema'
import { nowDb } from '../lib/dbTime'
import {
  buildDeepInput, deepEnabled, ensureDeepRequest, fetchBillText, fireDeepWorker, listOpenRequests, openRequest,
} from '../lib/deepAnalysis'
import { billHtmlToText } from '../lib/billText'
import { parseDeepContent, type DeepKind } from '../../../shared/deepAnalysis'
import type { AppEnv } from '../types'

/**
 * Deep analyses and hearing briefs.
 *
 * Team routes (session auth): read a subject's analysis, and (admins) request one.
 * Worker routes (/worker/*, bearer DEEP_WORKER_TOKEN): list open requests,
 * claim one, download its text, post the result or hand it back. The worker is
 * whatever the operator runs, such as a Claude Code routine.
 */
export const deepRouter = new Hono<AppEnv>()

const KINDS: DeepKind[] = ['bill', 'hearing']
const isKind = (k: string): k is DeepKind => (KINDS as string[]).includes(k)

function view(row: typeof deepAnalyses.$inferSelect | undefined) {
  if (!row) return { status: 'none' as const }
  // Re-validate on read, so content stored under an older shape shows as absent, not as a crash.
  let content: unknown = null
  if (row.content) { try { content = parseDeepContent(row.kind, JSON.parse(row.content)) } catch { content = null } }
  return {
    status: row.status,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
    model: row.model,
    content,
    // True when the shown content was written for an earlier version of the input.
    stale: !!content && row.contentInputHash !== row.inputHash,
    error: row.status === 'error' ? row.error : null,
  }
}

// ── Worker routes ──

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

const worker = new Hono<AppEnv>()
worker.use('*', async (c, next) => {
  const expected = c.env.DEEP_WORKER_TOKEN
  if (!deepEnabled(c.env) || !expected) return c.json({ error: 'Not found' }, 404)
  const got = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  // Compare digests so the check takes the same time whatever the token.
  const [a, b] = await Promise.all([digest(got), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  if (!got || diff !== 0) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

/** The row, if it is claimed for exactly this input. */
async function claimedRow(env: AppEnv['Bindings'], id: string, inputHash?: string) {
  const row = await getDb(env.DB).select().from(deepAnalyses).where(eq(deepAnalyses.id, id)).get()
  if (!row) return { error: 'Not found', status: 404 as const }
  if (row.status !== 'claimed') return { error: 'This request is not claimed. Claim it first.', status: 409 as const }
  if (inputHash !== undefined && inputHash !== row.inputHash) {
    return { error: 'The input changed since this request was claimed. Claim it again.', status: 409 as const }
  }
  return { row }
}

// GET /api/deep/worker/requests: open requests, bill analyses first, oldest first.
worker.get('/requests', async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 50)
  return c.json({ requests: await listOpenRequests(getDb(c.env.DB), limit) })
})

// POST /api/deep/worker/requests/:id/claim: take a request and get its input.
worker.post('/requests/:id/claim', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await c.req.json<{ worker?: string }>().catch(() => ({} as { worker?: string }))
  const open = await db.select().from(deepAnalyses).where(and(eq(deepAnalyses.id, id), openRequest)).get()
  if (!open) return c.json({ error: 'This request is not open.' }, 409)
  const workerName = typeof body.worker === 'string' ? body.worker.slice(0, 100) : 'worker'
  const res = await db.update(deepAnalyses)
    .set({ status: 'claimed', claimedAt: nowDb(), claimedBy: workerName, attempts: sql`${deepAnalyses.attempts} + 1` })
    .where(and(eq(deepAnalyses.id, id), eq(deepAnalyses.inputHash, open.inputHash), openRequest))
    .run()
  if (!res.meta.changes) return c.json({ error: 'This request is not open.' }, 409)
  const input = await buildDeepInput(c.env, db, open)
  if (!input) {
    await db.update(deepAnalyses).set({ status: 'error', error: 'The subject can no longer be analysed.', completedAt: nowDb() }).where(eq(deepAnalyses.id, id))
    return c.json({ error: 'The subject can no longer be analysed.' }, 410)
  }
  return c.json(input)
})

// GET /api/deep/worker/requests/:id/text: the bill text, as a PDF or plain text.
// 503 when central cannot serve it right now: the worker hands the request back
// and it is tried later, so no analysis is written without its text.
worker.get('/requests/:id/text', async (c) => {
  const found = await claimedRow(c.env, c.req.param('id'))
  if ('error' in found) return c.json({ error: found.error }, found.status)
  if (found.row.kind !== 'bill') return c.json({ error: 'Only bill requests have text.' }, 404)
  const b = await getDb(c.env.DB).select({ externalId: bills.externalId, isDraft: bills.isDraft }).from(bills).where(eq(bills.id, found.row.subjectId)).get()
  if (!b || b.isDraft || !b.externalId) return c.json({ error: 'This bill has no text.' }, 404)
  const t = await fetchBillText(c.env, b.externalId)
  if (t === 'missing') return c.json({ error: 'This bill has no text.' }, 404)
  if (t === 'unavailable') return c.json({ error: 'The bill text is unavailable right now. Hand the request back and try later.' }, 503)
  if (t.type === 'pdf') {
    const bin = atob(t.content)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } })
  }
  return new Response(billHtmlToText(t.content), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
})

// POST /api/deep/worker/requests/:id/release {inputHash}: hand a claimed request back.
worker.post('/requests/:id/release', async (c) => {
  const body = await c.req.json<{ inputHash?: string }>().catch(() => ({} as { inputHash?: string }))
  const found = await claimedRow(c.env, c.req.param('id'), body.inputHash ?? '')
  if ('error' in found) return c.json({ error: found.error }, found.status)
  await getDb(c.env.DB).update(deepAnalyses).set({ status: 'pending', claimedAt: null, claimedBy: null })
    .where(and(eq(deepAnalyses.id, found.row.id), eq(deepAnalyses.inputHash, found.row.inputHash), eq(deepAnalyses.status, 'claimed')))
  return c.json({ ok: true, status: 'pending' })
})

// POST /api/deep/worker/requests/:id/result {inputHash, model, content} or {inputHash, error}
worker.post('/requests/:id/result', async (c) => {
  const db = getDb(c.env.DB)
  const body = await c.req.json<{ inputHash?: string; model?: string; content?: unknown; error?: string }>()
    .catch(() => ({} as { inputHash?: string; model?: string; content?: unknown; error?: string }))
  const found = await claimedRow(c.env, c.req.param('id'), body.inputHash ?? '')
  if ('error' in found) return c.json({ error: found.error }, found.status)
  const row = found.row
  // Written only while the row is still claimed for this input: a change that
  // lands mid-request leaves the row pending for the new input.
  const stillClaimed = and(eq(deepAnalyses.id, row.id), eq(deepAnalyses.inputHash, row.inputHash), eq(deepAnalyses.status, 'claimed'))
  let set: Partial<typeof deepAnalyses.$inferInsert>
  if (typeof body.error === 'string' && body.content === undefined) {
    set = { status: 'error', error: body.error.slice(0, 1000), completedAt: nowDb() }
  } else {
    let content
    try { content = parseDeepContent(row.kind, body.content) } catch (err) {
      return c.json({ error: `Invalid content: ${(err as Error).message}` }, 400)
    }
    set = {
      status: 'done', content: JSON.stringify(content), contentInputHash: row.inputHash,
      model: typeof body.model === 'string' ? body.model.slice(0, 100) : null,
      completedAt: nowDb(), error: null, attempts: 0,
    }
  }
  const res = await db.update(deepAnalyses).set(set).where(stillClaimed).run()
  if (!res.meta.changes) return c.json({ error: 'The input changed since this request was claimed. Claim it again.' }, 409)
  return c.json({ ok: true, status: set.status })
})

// Mounted before the team routes so /worker/... never reads as /:kind/:subjectId.
deepRouter.route('/worker', worker)

// ── Team routes ──

// The Council events a bill is on (a hearing notice's roundtable, a bill's
// hearing), so its page can show each event's brief and team documents.
deepRouter.get('/bill/:billId/hearings', requireAuth, async (c) => {
  const db = getDb(c.env.DB)
  const events = await db.select({ id: calendarEvents.id, date: calendarEvents.date, time: calendarEvents.time, description: calendarEvents.description })
    .from(calendarEventBills).innerJoin(calendarEvents, eq(calendarEvents.id, calendarEventBills.eventId))
    .where(and(eq(calendarEventBills.billId, c.req.param('billId')), eq(calendarEvents.source, 'council'), ne(calendarEvents.status, 'cancelled')))
    .orderBy(asc(calendarEvents.date)).all()
  return c.json({ enabled: deepEnabled(c.env), events })
})

deepRouter.get('/:kind/:subjectId', requireAuth, async (c) => {
  const kind = c.req.param('kind')
  if (!isKind(kind)) return c.json({ error: 'Not found' }, 404)
  const db = getDb(c.env.DB)
  const subjectId = c.req.param('subjectId')
  const row = await db.select().from(deepAnalyses)
    .where(and(eq(deepAnalyses.kind, kind), eq(deepAnalyses.subjectId, subjectId))).get()
  // A hearing brief's page has no other source for the event it describes.
  const event = kind === 'hearing'
    ? await db.select({ id: calendarEvents.id, description: calendarEvents.description, date: calendarEvents.date, time: calendarEvents.time, location: calendarEvents.location, url: calendarEvents.url, source: calendarEvents.source, status: calendarEvents.status })
      .from(calendarEvents).where(eq(calendarEvents.id, subjectId)).get() ?? null
    : undefined
  return c.json({ enabled: deepEnabled(c.env), ...(event !== undefined ? { event } : {}), ...view(row) })
})

deepRouter.post('/:kind/:subjectId/request', requireAuth, requireAdmin, async (c) => {
  const kind = c.req.param('kind')
  if (!isKind(kind)) return c.json({ error: 'Not found' }, 404)
  if (!deepEnabled(c.env)) return c.json({ error: 'Deep analysis is not turned on for this team.' }, 409)
  const db = getDb(c.env.DB)
  const status = await ensureDeepRequest(db, kind, c.req.param('subjectId'), { force: true, requestedBy: c.get('user').id })
  if (!status) {
    return c.json({ error: kind === 'hearing' ? 'Hearing briefs cover DC Council events only.' : 'Nothing to analyse here.' }, 404)
  }
  c.executionCtx.waitUntil(fireDeepWorker(c.env, db, { manual: true }).catch(err => console.error('[deep] worker fire failed', err)))
  const row = await db.select().from(deepAnalyses)
    .where(and(eq(deepAnalyses.kind, kind), eq(deepAnalyses.subjectId, c.req.param('subjectId')))).get()
  return c.json({ enabled: true, ...view(row) })
})
