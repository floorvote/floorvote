import { and, eq, ne, isNull, isNotNull, gte, lt, exists, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { calendarEvents, calendarEventBills, bills, users, sessions, associationConfig } from '../db/schema'
import { renderWeekAheadEmail, type WeekAheadEvent, type WeekAheadDay } from './weekAheadEmail'
import { sendBatch, unsubscribeHeaders } from './email'
import { nowDb } from './dbTime'
import { prioritizedBillEntry, billEntryGroupKey } from './calendarVisibility'
import { loadDateFieldEvents } from './dateFieldEvents'
import { groupHasPriority, loadGroupPriorities, priorityWorn } from './teamFields'
import type { AppDb, Env } from '../types'
import { isModuleEnabled, getModuleSetting } from '../../../shared/modules'
import { PRODUCT_NAME } from '../../../shared/brand'
import { billDisplayTitle } from '../../../shared/billTitle'

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function isoDate(offsetDays: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

function formatDayLabel(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  const weekday = WEEKDAYS_LONG[d.getUTCDay()]
  const monthName = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  return `${weekday}, ${monthName} ${day}`
}

async function stampLastWeekAhead(db: AppDb, now: string): Promise<void> {
  await db.insert(associationConfig).values({ key: 'last_week_ahead_at', value: now })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: now } })
}

export async function runWeekAhead(env: Env, db: AppDb): Promise<void> {
  // Module gate
  const modulesRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'modules')).get()
  const modules = modulesRow?.value
    ? (() => { try { return JSON.parse(modulesRow.value) } catch { return undefined } })()
    : undefined
  if (!isModuleEnabled(modules, 'week-ahead')) return

  // Weekday gate — only send on configured day (default Monday = 1)
  const weeklyDay = getModuleSetting<string>(modules, 'week-ahead', 'weeklyDay', '1')
  if (String(new Date().getUTCDay()) !== String(weeklyDay)) return

  const todayIso = isoDate(0)
  const endIso = isoDate(7)  // exclusive

  // Query non-cancelled events in the window.
  // Custom: all. A bill's own entry (a hearing or markup, not a deadline) when
  // its bill has a priority, by the rule the calendar applies
  // (prioritizedBillEntry). Anything else: only with at least one linked bill
  // with priority. A body event (the legislature's own calendar) links its
  // agenda bills, so one with a prioritized bill on the agenda is in. The
  // instance's event rules never hide those (lib/eventRules.ts), but a bill
  // prioritized since the rules last ran would wait an hour without this. So
  // is any body event the calendar shows: one the rules select (rule_match 1),
  // or every one while the instance has no rules (rule_match null, "All
  // events"), so the email lists what the calendar does (#420).
  const linkedBills = alias(bills, 'linked_bills')
  const rows = await db
    .select({
      eventId: calendarEvents.id,
      eventHash: calendarEvents.eventHash,
      source: calendarEvents.source,
      date: calendarEvents.date,
      time: calendarEvents.time,
      description: calendarEvents.description,
      location: calendarEvents.location,
      details: calendarEvents.details,
      url: calendarEvents.url,
      status: calendarEvents.status,
      kind: calendarEvents.kind,
      // A bill entry carries its own bill; a custom or body event, its linked ones.
      ownBillId: bills.id,
      ownBillNumber: bills.billNumber,
      ownBillState: bills.state,
      ownBillTitle: bills.title,
      ownBillIsDraft: bills.isDraft,
      ownBillPriority: bills.priority,
      ownBillGroupKey: bills.groupKey,
      linkedBillId: calendarEventBills.billId,
      linkedBillNumber: linkedBills.billNumber,
      linkedBillState: linkedBills.state,
      linkedBillTitle: linkedBills.title,
      linkedBillIsDraft: linkedBills.isDraft,
      linkedBillPriority: linkedBills.priority,
      linkedBillGroupKey: linkedBills.groupKey,
    })
    .from(calendarEvents)
    .leftJoin(bills, eq(bills.id, calendarEvents.billId))
    .leftJoin(calendarEventBills, eq(calendarEventBills.eventId, calendarEvents.id))
    .leftJoin(linkedBills, eq(linkedBills.id, calendarEventBills.billId))
    .where(
      and(
        ne(calendarEvents.status, 'cancelled'),
        isNotNull(calendarEvents.date),
        gte(calendarEvents.date, todayIso),
        lt(calendarEvents.date, endIso),
        or(
          and(prioritizedBillEntry, sql`${calendarEvents.kind} IS NOT 'deadline'`),
          eq(calendarEvents.source, 'custom'),
          and(eq(calendarEvents.source, 'body'), or(isNull(calendarEvents.ruleMatch), eq(calendarEvents.ruleMatch, 1))),
          exists(
            db.select({ _: sql`1` })
              .from(calendarEventBills)
              .innerJoin(bills, eq(bills.id, calendarEventBills.billId))
              .where(and(
                eq(calendarEventBills.eventId, calendarEvents.id),
                // A companion group has one priority: a linked bill qualifies through any member.
                groupHasPriority(bills),
              ))
          ),
        ),
      ),
    )
    .orderBy(calendarEvents.date, calendarEvents.time)
    .all()

  // Date custom fields on prioritized bills (#342): all-day, and projected
  // rather than stored, so they come from their own query, whose `to` is
  // inclusive: the window's last day, the one before the exclusive `endIso`.
  const lastIso = isoDate(6)
  const fieldEvents = await loadDateFieldEvents(db, { from: todayIso, to: lastIso })

  if (rows.length === 0 && fieldEvents.length === 0) return  // no events this week — skip without stamping

  // Group rows by event, then events by date. Bill entries for the same real
  // meeting on several bills are one event carrying every bill, as the
  // calendar page shows them.
  // A companion group's bills wear the group's priority, whichever member holds it.
  const groupPriorities = await loadGroupPriorities(db, rows.flatMap(r => [r.ownBillGroupKey, r.linkedBillGroupKey]))
  const eventMap = new Map<string, WeekAheadEvent>()
  const eventDateMap = new Map<string, string>()  // eventId → date
  const meetingIds = new Map<string, string>()  // bill entry group key → eventId
  const dateOrder: string[] = []

  // All-day, so first among their day's events, as an untimed hearing is.
  for (const f of fieldEvents) {
    eventMap.set(f.id, { id: f.id, source: 'field', fieldName: f.fieldName, description: f.title, status: 'confirmed', bills: [{ id: f.bill.id, billNumber: f.bill.billNumber, state: f.bill.state, priority: f.bill.priority, billTitle: f.bill.billTitle }] })
    eventDateMap.set(f.id, f.date)
    if (!dateOrder.includes(f.date)) dateOrder.push(f.date)
  }

  for (const row of rows) {
    const meetingKey = row.source === 'hearing' ? billEntryGroupKey(row) : null
    const eventId = (meetingKey && meetingIds.get(meetingKey)) || row.eventId
    if (!eventMap.has(eventId)) {
      eventMap.set(eventId, {
        id: row.eventId,
        eventHash: row.eventHash,
        source: row.source,
        description: row.description,
        location: row.location,
        time: row.time,
        details: row.details,
        url: row.url,
        status: row.status,
        bills: [],
      })
      if (meetingKey) meetingIds.set(meetingKey, eventId)
      const d = row.date ?? ''
      eventDateMap.set(eventId, d)
      if (d && !dateOrder.includes(d)) dateOrder.push(d)
    }
    const ev = eventMap.get(eventId)!
    const bill = row.linkedBillId
      ? { id: row.linkedBillId, number: row.linkedBillNumber, state: row.linkedBillState, title: row.linkedBillTitle, isDraft: row.linkedBillIsDraft, priority: priorityWorn({ priority: row.linkedBillPriority, groupKey: row.linkedBillGroupKey }, groupPriorities) }
      : { id: row.ownBillId, number: row.ownBillNumber, state: row.ownBillState, title: row.ownBillTitle, isDraft: row.ownBillIsDraft, priority: priorityWorn({ priority: row.ownBillPriority, groupKey: row.ownBillGroupKey }, groupPriorities) }
    if (bill.id && !ev.bills.some(b => b.id === bill.id)) {
      ev.bills.push({
        id: bill.id,
        billNumber: bill.number ?? '',
        state: bill.state,
        priority: bill.priority as 'high' | 'medium' | 'low' | null,
        billTitle: billDisplayTitle({ title: bill.title, isDraft: bill.isDraft }),
      })
    }
  }

  dateOrder.sort()  // date-field events joined the days the query ordered

  // Build days array
  const dayEventMap = new Map<string, WeekAheadEvent[]>()
  for (const [eventId, ev] of eventMap.entries()) {
    const d = eventDateMap.get(eventId) ?? ''
    if (!dayEventMap.has(d)) dayEventMap.set(d, [])
    dayEventMap.get(d)!.push(ev)
  }

  const days: WeekAheadDay[] = dateOrder
    .filter(d => dayEventMap.has(d))
    .map(d => ({ date: d, label: formatDayLabel(d), events: dayEventMap.get(d)! }))

  if (days.length === 0) return

  // Recipients: opted-in users with active sessions
  const recipients = await db.select({ email: users.email }).from(users)
    .where(and(
      eq(users.emailWeekAheadEnabled, 1),
      exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))),
    )).all()
  if (recipients.length === 0) { await stampLastWeekAhead(db, nowDb()); return }

  // Association name
  const nameRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get()
  let assocName = PRODUCT_NAME
  if (nameRow?.value) { try { assocName = JSON.parse(nameRow.value) } catch { assocName = nameRow.value } }

  const firstDay = days[0].label.split(', ').slice(1).join(', ')
  const lastDay = days[days.length - 1].label.split(', ').slice(1).join(', ')
  const range = firstDay === lastDay ? firstDay : `${firstDay}–${lastDay}`
  const subject = `${assocName}: Your week ahead — ${range}`
  const html = renderWeekAheadEmail({ days, assocName, appUrl: env.APP_URL })

  const headers = unsubscribeHeaders(env.APP_URL, 'setting-week-ahead')
  await sendBatch(
    env,
    recipients.map(r => ({ to: [r.email], subject, html, headers })),
    'week-ahead',
    db,
    { bulk: true },
  )
  await stampLastWeekAhead(db, nowDb())
}
