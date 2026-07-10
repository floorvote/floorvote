import { and, eq, gt, inArray, isNotNull, isNull, exists, sql } from 'drizzle-orm'
import { feedEvents, bills, users, sessions, associationConfig } from '../db/schema'
import { renderDigestEmail, type DigestEvent, type NewMatchDigestItem } from './digestEmail'
import { sendBatch, unsubscribeHeaders } from './email'
import { nowDb } from './dbTime'
import { getNewMatchMinRelevance } from './newMatch'
import type { AppDb, Env } from '../types'
import { isModuleEnabled, getModuleSetting, type ModulesConfig } from '../../../shared/modules'
import { PRODUCT_NAME } from '../../../shared/brand'

const DIGEST_CATEGORIES = ['bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled', 'position_set']

async function readModules(db: AppDb): Promise<ModulesConfig | undefined> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'modules')).get()
  if (!row?.value) return undefined
  try { return JSON.parse(row.value) as ModulesConfig } catch { return undefined }
}

async function stampLastDigest(db: AppDb, now: string): Promise<void> {
  await db.insert(associationConfig).values({ key: 'last_digest_at', value: now })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: now } })
}

export type DigestResult = { ok: true; recipients: number; sent: number; failed: number }

export async function runDigest(
  env: Env, db: AppDb, opts: { ignoreSchedule?: boolean } = {},
): Promise<DigestResult> {
  // Note: demo instances never actually send — sendBatch suppresses all
  // notification email when DEMO_MODE is set. The digest still shows as enabled
  // (read-only) in the demo UI.
  const modules = await readModules(db)
  if (!isModuleEnabled(modules, 'email-digest')) return { ok: true, recipients: 0, sent: 0, failed: 0 }

  // Weekly cadence: only send on the chosen UTC weekday. Skip WITHOUT stamping
  // last_digest_at so the window accumulates the full week.
  const frequency = getModuleSetting<string>(modules, 'email-digest', 'frequency', 'daily')
  if (frequency === 'weekly' && !opts.ignoreSchedule) {
    const weeklyDay = getModuleSetting(modules, 'email-digest', 'weeklyDay', '1')
    if (String(new Date().getUTCDay()) !== String(weeklyDay)) return { ok: true, recipients: 0, sent: 0, failed: 0 }
  }

  const lastRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'last_digest_at')).get()
  // last_digest_at is a stored config-string timestamp, read back and compared
  // via datetime() at the query below — keep it space format.
  const since = lastRow?.value ?? new Date(Date.now() - 86400_000).toISOString().slice(0, 19).replace('T', ' ')
  const now = nowDb()

  const events: DigestEvent[] = await db
    .select({
      type: feedEvents.type, metadata: feedEvents.metadata, createdAt: feedEvents.createdAt,
      billId: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, billSession: bills.session, priority: bills.priority,
      summary: bills.tenantSummary,
      userName: users.name,
    })
    .from(feedEvents)
    .innerJoin(bills, eq(feedEvents.billId, bills.id))
    .leftJoin(users, eq(feedEvents.userId, users.id))
    .where(and(isNotNull(bills.priority), inArray(feedEvents.type, DIGEST_CATEGORIES as any), sql`datetime(${feedEvents.createdAt}) > datetime(${since})`, eq(feedEvents.suppressed, false)))
    .all()

  // New keyword matches awaiting triage — admin/owner section only. Bill-based
  // (not feed events) and NOT priority-gated; scoped to the digest window, still
  // untriaged, and above the configured relevance threshold.
  const threshold = await getNewMatchMinRelevance(db)
  const newMatches: NewMatchDigestItem[] = await db.select({
      billId: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, billSession: bills.session, relevanceScore: bills.relevanceScore,
    })
    .from(bills)
    .where(and(
      eq(bills.matchType, 'keyword'),
      isNotNull(bills.newMatchAt),
      isNull(bills.priority),
      isNull(bills.triagedAt),
      sql`datetime(${bills.newMatchAt}) > datetime(${since})`,
      sql`datetime(${bills.newMatchAt}) <= datetime(${now})`,
      sql`COALESCE(${bills.relevanceScore}, 0) >= ${threshold}`,
    ))
    .orderBy(sql`${bills.relevanceScore} DESC NULLS LAST`)
    .all()

  if (events.length === 0 && newMatches.length === 0) { await stampLastDigest(db, now); return { ok: true, recipients: 0, sent: 0, failed: 0 } }

  const recipients = await db.select({ email: users.email, role: users.role }).from(users)
    .where(and(
      eq(users.emailDigestEnabled, 1),
      exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))),
    )).all()
  if (recipients.length === 0) { await stampLastDigest(db, now); return { ok: true, recipients: 0, sent: 0, failed: 0 } }

  const nameRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get()
  let assocName = PRODUCT_NAME
  if (nameRow?.value) { try { assocName = JSON.parse(nameRow.value) } catch { assocName = nameRow.value } }

  const headers = unsubscribeHeaders(env.APP_URL, 'setting-email-digest')
  const billCount = new Set(events.map(e => e.billId)).size

  // Members get the unchanged priority-event digest. Admins/owners get that plus the
  // new-match section. Members are skipped entirely when there are no priority events.
  const memberHtml = events.length > 0
    ? renderDigestEmail({ events, assocName, appUrl: env.APP_URL, periodStart: since, periodEnd: now })
    : null
  const memberSubject = `${assocName}: ${billCount} priority bill${billCount === 1 ? '' : 's'} updated`
  const adminHtml = renderDigestEmail({ events, assocName, appUrl: env.APP_URL, periodStart: since, periodEnd: now, newMatches })
  const adminSubject = billCount > 0
    ? memberSubject
    : `${assocName}: ${newMatches.length} new bill${newMatches.length === 1 ? '' : 's'} matching your keywords`

  const messages = recipients.flatMap(r => {
    const isAdmin = r.role === 'admin' || r.role === 'owner'
    if (isAdmin) return [{ to: [r.email], subject: adminSubject, html: adminHtml, headers }]
    if (memberHtml) return [{ to: [r.email], subject: memberSubject, html: memberHtml, headers }]
    return []
  })
  if (messages.length === 0) { await stampLastDigest(db, now); return { ok: true, recipients: 0, sent: 0, failed: 0 } }

  const { sent, failed } = await sendBatch(env, messages, 'digest', db)
  await stampLastDigest(db, now)
  return { ok: true, recipients: messages.length, sent, failed }
}
