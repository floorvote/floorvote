import { Hono } from 'hono'
import { and, eq, gte } from 'drizzle-orm'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { getDb } from '../db/client'
import { bills, calendarEvents, deepAnalyses, teamLinks } from '../db/schema'
import { ensureDeepRequest, fireDeepWorker, requestDeepForPrioritized } from '../lib/deepAnalysis'
import type { AppEnv } from '../types'

/**
 * Team documents: links admins attach to a bill or calendar event. Members see
 * them; the deep-analysis worker reads them for that subject's analysis or brief.
 */
export const linksRouter = new Hono<AppEnv>()

const KINDS = ['bill', 'event'] as const
type Kind = typeof KINDS[number]
const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k)
const MAX_LINKS = 20

/**
 * A changed set of documents changes the subject's analysis input: re-request
 * it (a priority bill, or an event that already has a brief) and start the worker.
 */
function refreshAnalysis(c: { env: AppEnv['Bindings']; executionCtx: { waitUntil(p: Promise<unknown>): void } }, kind: Kind, subjectId: string) {
  c.executionCtx.waitUntil((async () => {
    const db = getDb(c.env.DB)
    if (kind === 'bill') await requestDeepForPrioritized(c.env, db, [subjectId])
    else {
      // Only an upcoming event that already has a brief: a past one is left as it was.
      const has = await db.select({ id: deepAnalyses.id }).from(deepAnalyses)
        .innerJoin(calendarEvents, eq(calendarEvents.id, deepAnalyses.subjectId))
        .where(and(eq(deepAnalyses.kind, 'hearing'), eq(deepAnalyses.subjectId, subjectId), gte(calendarEvents.date, new Date().toISOString().slice(0, 10)))).get()
      if (has) await ensureDeepRequest(db, 'hearing', subjectId)
    }
    await fireDeepWorker(c.env, db, { manual: true })
  })().catch(err => console.error('[links] analysis refresh failed', err)))
}

async function subjectExists(db: ReturnType<typeof getDb>, kind: Kind, id: string): Promise<boolean> {
  // Drafts are the team's own and have no analysis, so they take no links.
  const row = kind === 'bill'
    ? await db.select({ id: bills.id }).from(bills).where(and(eq(bills.id, id), eq(bills.isDraft, false))).get()
    : await db.select({ id: calendarEvents.id }).from(calendarEvents).where(eq(calendarEvents.id, id)).get()
  return !!row
}

linksRouter.get('/:kind/:subjectId', requireAuth, async (c) => {
  const kind = c.req.param('kind')
  if (!isKind(kind)) return c.json({ error: 'Not found' }, 404)
  const rows = await getDb(c.env.DB).select({ id: teamLinks.id, title: teamLinks.title, url: teamLinks.url, addedAt: teamLinks.addedAt })
    .from(teamLinks).where(and(eq(teamLinks.subjectKind, kind), eq(teamLinks.subjectId, c.req.param('subjectId'))))
    .orderBy(teamLinks.addedAt).all()
  return c.json({ links: rows })
})

linksRouter.post('/:kind/:subjectId', requireAuth, requireAdmin, async (c) => {
  const kind = c.req.param('kind')
  if (!isKind(kind)) return c.json({ error: 'Not found' }, 404)
  const subjectId = c.req.param('subjectId')
  const body = await c.req.json<{ title?: string; url?: string }>().catch(() => ({} as { title?: string; url?: string }))
  const title = (body.title ?? '').trim().slice(0, 200)
  const raw = (body.url ?? '').trim().slice(0, 2000)
  let url: URL
  try { url = new URL(raw) } catch { return c.json({ error: 'Paste a full link, starting with https://' }, 400) }
  if (url.protocol !== 'https:') return c.json({ error: 'Links must start with https://' }, 400)
  if (!title) return c.json({ error: 'Give the document a title.' }, 400)
  const db = getDb(c.env.DB)
  if (!await subjectExists(db, kind, subjectId)) return c.json({ error: 'Not found' }, 404)
  const count = (await db.select({ id: teamLinks.id }).from(teamLinks).where(and(eq(teamLinks.subjectKind, kind), eq(teamLinks.subjectId, subjectId))).all()).length
  if (count >= MAX_LINKS) return c.json({ error: `At most ${MAX_LINKS} documents per item.` }, 400)
  const id = crypto.randomUUID()
  await db.insert(teamLinks).values({ id, subjectKind: kind, subjectId, title, url: url.toString(), addedBy: c.get('user').id })
  refreshAnalysis(c, kind, subjectId)
  return c.json({ id, title, url: url.toString() }, 201)
})

linksRouter.delete('/:id', requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB)
  const row = await db.select().from(teamLinks).where(eq(teamLinks.id, c.req.param('id'))).get()
  if (!row) return c.json({ error: 'Not found' }, 404)
  await db.delete(teamLinks).where(eq(teamLinks.id, row.id))
  refreshAnalysis(c, row.subjectKind, row.subjectId)
  return new Response(null, { status: 204 })
})
