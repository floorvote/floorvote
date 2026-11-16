import { and, eq, gt, inArray, exists, sql } from 'drizzle-orm'
import { feedEvents, bills, users, sessions, associationConfig } from '../db/schema'
import { renderDigestEmail, digestSubject, digestCadence, digestCardKey, countUpdatedBills, countNewMatches, countViewBills, type DigestEvent, type DigestSettingsAnchor, type NewMatchDigestItem, type ViewDigestSection } from './digestEmail'
import { buildViewSections, DIGEST_CATEGORIES } from './digestViews'
import { senderFor, unsubscribeHeaders } from './email'
import { nowDb } from './dbTime'
import { getNewMatchMinRelevance, routineNewMatchWhere } from './newMatch'
import { groupHasPriority, loadGroupPriorities, priorityWorn } from './teamFields'
import { activeUser } from './accountDeletion'
import { newBillsChoice } from './newBillsChoice'
import { readModules } from './modulesConfig'
import type { AppDb, Env } from '../types'
import { digestTeamChoice, newlyFoundOn, type DigestTeamChoice, type ModulesConfig } from '../../../shared/modules'
import { PRODUCT_NAME } from '../../../shared/brand'
import { userDisplayNameSql } from './displayName'

/**
 * A digest schedule (migration 0130). Each person gets the digest every morning (weeklyDay null) or once a week on the
 * weekday they picked (users.email_digest_weekly_day, 0 Sunday to 6 Saturday, UTC). Each schedule keeps its own window:
 * `lastKey` holds where its last one ended, and a schedule that has never been sent reaches back `firstDays`.
 */
type Schedule = { weeklyDay: number | null; lastKey: string; firstDays: number }
const DAILY: Schedule = { weeklyDay: null, lastKey: 'last_digest_at', firstDays: 1 }
const weekly = (day: number): Schedule => ({ weeklyDay: day, lastKey: `last_weekly_digest_at_${day}`, firstDays: 7 })

async function stampLast(db: AppDb, schedule: Schedule, now: string): Promise<void> {
  await db.insert(associationConfig).values({ key: schedule.lastKey, value: now })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: now } })
}

/** A digest run's counts. `skipped: 'off'` marks a run that did no work because the team turned the digest off, which can't mark a failed run's alert resolved and ends that alert's conversation (lib/jobAlert.ts). */
export type DigestResult = { ok: true; recipients: number; sent: number; failed: number; skipped?: 'off' }

export async function runDigest(
  env: Env, db: AppDb, opts: { ignoreSchedule?: boolean } = {},
): Promise<DigestResult> {
  // Note: demo instances never actually send — the bulk purpose is suppressed
  // when DEMO_MODE is set. The digest still shows as enabled
  // (read-only) in the demo UI.
  const modules = await readModules(db)
  // Off: no one gets it, followed views included. Saved views only: the priority and newly found parts are no one's.
  const teamChoice = digestTeamChoice(modules)
  if (teamChoice === 'off') return { ok: true, recipients: 0, sent: 0, failed: 0, skipped: 'off' }

  const people = await db.select({
      id: users.id, email: users.email, role: users.role, newBills: users.emailDigestNewBills, priorityEnabled: users.emailDigestEnabled,
      weeklyDay: users.emailDigestWeeklyDay,
    }).from(users)
    .where(exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))))
    .all()

  // The daily digest goes every run, and today's weekday's weekly one with it. A send-now run sends every weekday's.
  const days = opts.ignoreSchedule ? [0, 1, 2, 3, 4, 5, 6] : [new Date().getUTCDay()]
  const total: DigestResult = { ok: true, recipients: 0, sent: 0, failed: 0 }
  for (const schedule of [DAILY, ...days.map(weekly)]) {
    const r = await sendSchedule(env, db, { modules, teamChoice, schedule, recipients: people.filter(p => (p.weeklyDay ?? null) === schedule.weeklyDay) })
    total.recipients += r.recipients
    total.sent += r.sent
    total.failed += r.failed
  }
  return total
}

type Recipient = { id: string; email: string; role: string; newBills: number | null; priorityEnabled: number }

/** One schedule's digest: what changed in its window, sent to the people on it. The window moves on whether or not anything went out. */
async function sendSchedule(
  env: Env, db: AppDb,
  { modules, teamChoice, schedule, recipients }: { modules: ModulesConfig; teamChoice: DigestTeamChoice; schedule: Schedule; recipients: Recipient[] },
): Promise<{ recipients: number; sent: number; failed: number }> {
  const now = nowDb()
  const none = { recipients: 0, sent: 0, failed: 0 }
  if (recipients.length === 0) { await stampLast(db, schedule, now); return none }

  const lastRow = await db.select().from(associationConfig).where(eq(associationConfig.key, schedule.lastKey)).get()
  // The window's start is a stored config-string timestamp, read back and compared
  // via datetime() at the query below — keep it space format.
  const since = lastRow?.value ?? new Date(Date.now() - schedule.firstDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ')

  const teamSendsParts = teamChoice === 'on'
  const eventRows = !teamSendsParts ? [] : await db
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

  // New keyword matches awaiting triage: the newly found bills part, for each person who gets it (hasFoundPart, below).
  // Bill-based (not feed events) and NOT priority-gated; scoped to the digest window. Only
  // routine matches, under the same new-match definition (and threshold) as the
  // triage list and chip: a seed's or keyword re-run's matches stay in the
  // triage list and out of the digest. All of them are passed on:
  // renderDigestEmail counts the lot, then ranks and caps what it lists.
  const threshold = await getNewMatchMinRelevance(db)
  const newMatches: NewMatchDigestItem[] = !teamSendsParts ? [] : await db.select({
      billId: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, billSession: bills.session, billSessionSlug: bills.sessionSlug, relevanceScore: bills.relevanceScore,
      summary: bills.tenantSummary, billGroupKey: bills.groupKey,
    })
    .from(bills)
    .where(and(
      // Triaging any bill in a companion group triages the group (newMatchWhere).
      routineNewMatchWhere(threshold),
      sql`datetime(${bills.newMatchAt}) > datetime(${since})`,
      sql`datetime(${bills.newMatchAt}) <= datetime(${now})`,
    ))
    .all()

  // Which parts a person gets (#1035). Priority bills and newly found bills need the team choice On and the person's
  // own switch for each. A newly found choice that is unset follows the team's default for a member and is on for an
  // admin or owner (#1036). A followed view is always theirs.
  const hasPriorityPart = (r: Recipient) => teamSendsParts && r.priorityEnabled === 1
  const hasFoundPart = (r: Recipient) => teamSendsParts && newlyFoundOn(newBillsChoice(r.newBills), r.role, modules)
  const recipientById = new Map(recipients.map(r => [r.id, r]))
  // Saved views a recipient included (#449): each view's news in the window, minus what their digest already shows
  // as a priority bill, so a bill appears once. Someone without the priority part sees it in the view.
  const priorityKeys = new Set(events.map(digestCardKey))
  const noKeys = new Set<string>()
  const viewSections = await buildViewSections(db, {
    userIds: recipients.map(r => r.id), since, now,
    shownKeys: id => (hasPriorityPart(recipientById.get(id)!) ? priorityKeys : noKeys),
  })

  if (events.length === 0 && newMatches.length === 0 && viewSections.size === 0) { await stampLast(db, schedule, now); return none }

  const nameRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get()
  let assocName = PRODUCT_NAME
  if (nameRow?.value) { try { assocName = JSON.parse(nameRow.value) } catch { assocName = nameRow.value } }

  const cadence = digestCadence(since, now)
  const render = (opts: { events: DigestEvent[]; newMatches?: NewMatchDigestItem[]; forMember?: boolean; views?: ViewDigestSection[]; settingsAnchor: DigestSettingsAnchor }) =>
    renderDigestEmail({ assocName, appUrl: env.APP_URL, periodStart: since, periodEnd: now, ...opts })

  // Each person's email is their parts: priority bills, then newly found bills, then their views. The subject counts the
  // same cards the sections show. Everyone without views and with the same parts gets the same email, rendered once.
  const shared = new Map<string, { subject: string; html: string }>()
  const messages = recipients.flatMap(r => {
    const isAdmin = r.role === 'admin' || r.role === 'owner'
    const myEvents = hasPriorityPart(r) ? events : []
    const myMatches = hasFoundPart(r) ? newMatches : []
    const views = viewSections.get(r.id)
    if (myEvents.length === 0 && myMatches.length === 0 && !views) return []
    // Decided once per email: one that holds only saved views is stopped by unsubscribing from those. The header and the
    // footer link both use this value.
    const settingsAnchor: DigestSettingsAnchor = myEvents.length === 0 && myMatches.length === 0 ? 'setting-saved-views' : 'setting-email-digest'
    const headers = unsubscribeHeaders(env.APP_URL, settingsAnchor)
    if (views) {
      const subject = digestSubject({ updatedBills: countUpdatedBills(myEvents), newMatches: countNewMatches(myMatches), viewBills: countViewBills(views), cadence })
      return [{ to: [r.email], subject, html: render({ events: myEvents, newMatches: myMatches, forMember: !isAdmin, views, settingsAnchor }), headers }]
    }
    const key = `${myEvents.length > 0}:${myMatches.length > 0}:${isAdmin}`
    if (!shared.has(key)) {
      shared.set(key, {
        subject: digestSubject({ updatedBills: countUpdatedBills(myEvents), newMatches: countNewMatches(myMatches), cadence }),
        html: render({ events: myEvents, newMatches: myMatches, forMember: !isAdmin, settingsAnchor }),
      })
    }
    return [{ to: [r.email], ...shared.get(key)!, headers }]
  })
  if (messages.length === 0) { await stampLast(db, schedule, now); return none }

  const { sent, failed } = await senderFor(env, db).sendBatch(messages.map(m => ({ purpose: 'bulk' as const, ...m })))
  console.log(`[digest] ${schedule.weeklyDay === null ? 'daily' : `weekly on day ${schedule.weeklyDay}`}: sent ${sent}, failed ${failed}`)
  await stampLast(db, schedule, now)
  return { recipients: messages.length, sent, failed }
}
