import { and, eq, gt, inArray, exists, sql } from 'drizzle-orm'
import { feedEvents, bills, users, sessions, associationConfig } from '../db/schema'
import { renderDigestEmail, digestSubject, digestCadence, countUpdatedBills, type DigestEvent, type NewMatchDigestItem } from './digestEmail'
import { sendBatch, unsubscribeHeaders } from './email'
import { nowDb } from './dbTime'
import { getNewMatchMinRelevance, routineNewMatchWhere } from './newMatch'
import { groupHasPriority, loadGroupPriorities, priorityWorn } from './teamFields'
import { activeUser } from './accountDeletion'
import type { AppDb, Env } from '../types'
import { isModuleEnabled, getModuleSetting, type ModulesConfig } from '../../../shared/modules'
import { PRODUCT_NAME } from '../../../shared/brand'
import { userDisplayNameSql } from './displayName'

const DIGEST_CATEGORIES = ['bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled', 'position_set', 'comment_added', 'priority_set']

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

  const eventRows = await db
    .select({
      type: feedEvents.type, metadata: feedEvents.metadata, createdAt: feedEvents.createdAt,
      billId: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, billSession: bills.session, billSessionSlug: bills.sessionSlug, priority: bills.priority,
      summary: bills.tenantSummary, billIsDraft: bills.isDraft, billGroupKey: bills.groupKey,
      userName: userDisplayNameSql,
    })
    .from(feedEvents)
    .innerJoin(bills, eq(feedEvents.billId, bills.id))
    .leftJoin(users, eq(feedEvents.userId, users.id))
    // activeUser excludes events authored by a deactivated member; events from the
    // synthetic 'system' author don't match a users row, so it's a no-op for those.
    // A companion group is one policy: a group with a priority qualifies through any member, and its events share a card.
    .where(and(groupHasPriority(bills), inArray(feedEvents.type, DIGEST_CATEGORIES as any), sql`datetime(${feedEvents.createdAt}) > datetime(${since})`, eq(feedEvents.suppressed, false), activeUser))
    .all()
  // A companion group's events wear the group's priority, whichever member holds it.
  const groupPriorities = await loadGroupPriorities(db, eventRows.map(e => e.billGroupKey))
  const events: DigestEvent[] = eventRows.map(e => ({ ...e, priority: priorityWorn({ priority: e.priority, groupKey: e.billGroupKey }, groupPriorities) }))

  // New keyword matches awaiting triage — the section admins always get and
  // members get unless they turned off "Include newly matched bills". Bill-based
  // (not feed events) and NOT priority-gated; scoped to the digest window. Only
  // routine matches, under the same new-match definition (and threshold) as the
  // triage list and chip: a seed's or keyword re-run's matches stay in the
  // triage list and out of the digest. All of them are passed on:
  // renderDigestEmail counts the lot, then ranks and caps what it lists.
  const threshold = await getNewMatchMinRelevance(db)
  const newMatches: NewMatchDigestItem[] = await db.select({
      billId: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, billSession: bills.session, billSessionSlug: bills.sessionSlug, relevanceScore: bills.relevanceScore,
      summary: bills.tenantSummary,
    })
    .from(bills)
    .where(and(
      // Triaging any bill in a companion group triages the group (newMatchWhere).
      routineNewMatchWhere(threshold),
      sql`datetime(${bills.newMatchAt}) > datetime(${since})`,
      sql`datetime(${bills.newMatchAt}) <= datetime(${now})`,
    ))
    .all()

  if (events.length === 0 && newMatches.length === 0) { await stampLastDigest(db, now); return { ok: true, recipients: 0, sent: 0, failed: 0 } }

  const recipients = await db.select({ email: users.email, role: users.role, matchesEnabled: users.emailDigestMatchesEnabled }).from(users)
    .where(and(
      eq(users.emailDigestEnabled, 1),
      exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))),
    )).all()
  if (recipients.length === 0) { await stampLastDigest(db, now); return { ok: true, recipients: 0, sent: 0, failed: 0 } }

  const nameRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get()
  let assocName = PRODUCT_NAME
  if (nameRow?.value) { try { assocName = JSON.parse(nameRow.value) } catch { assocName = nameRow.value } }

  const headers = unsubscribeHeaders(env.APP_URL, 'setting-email-digest')
  // One per card, so a companion group counts once however many of its bills changed.
  const billCount = countUpdatedBills(events)

  // Updates lead; the new-match section follows. A recipient who gets the section
  // is every admin/owner and each member who hasn't turned off "Include newly
  // matched bills". The rest get the priority-event digest alone, and none at all
  // when there are no priority events.
  const cadence = digestCadence(since, now)
  const subjectWithMatches = digestSubject({ updatedBills: billCount, newMatches: newMatches.length, cadence })
  const updatesOnlySubject = digestSubject({ updatedBills: billCount, newMatches: 0, cadence })
  const render = (opts: { newMatches?: NewMatchDigestItem[]; forMember?: boolean }) =>
    renderDigestEmail({ events, assocName, appUrl: env.APP_URL, periodStart: since, periodEnd: now, ...opts })
  const adminHtml = render({ newMatches })
  const memberWithMatchesHtml = render({ newMatches, forMember: true })
  const updatesOnly = events.length > 0
    ? { subject: updatesOnlySubject, html: render({}) }
    : null

  const messages = recipients.flatMap(r => {
    const isAdmin = r.role === 'admin' || r.role === 'owner'
    if (isAdmin) return [{ to: [r.email], subject: subjectWithMatches, html: adminHtml, headers }]
    if (r.matchesEnabled === 1) return [{ to: [r.email], subject: subjectWithMatches, html: memberWithMatchesHtml, headers }]
    if (updatesOnly) return [{ to: [r.email], ...updatesOnly, headers }]
    return []
  })
  if (messages.length === 0) { await stampLastDigest(db, now); return { ok: true, recipients: 0, sent: 0, failed: 0 } }

  const { sent, failed } = await sendBatch(env, messages, 'digest', db, { bulk: true })
  await stampLastDigest(db, now)
  return { ok: true, recipients: messages.length, sent, failed }
}
