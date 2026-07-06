import { and, eq, ne, isNotNull, gte, lt, exists, or, sql } from 'drizzle-orm'
import { calendarEvents, calendarEventBills, bills, users, sessions, associationConfig } from '../db/schema'
import { renderWeekAheadEmail, type WeekAheadEvent, type WeekAheadDay } from './weekAheadEmail'
import { sendBatch, unsubscribeHeaders } from './email'
import { nowDb } from './dbTime'
import type { AppDb, Env } from '../types'
import { isModuleEnabled, getModuleSetting } from '../../../shared/modules'
import { PRODUCT_NAME } from '../../../shared/brand'

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
  // Hearings: only those with at least one linked bill with priority.
  // Custom/other: all.
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
      billId: calendarEventBills.billId,
      billNumber: bills.billNumber,
      billState: bills.state,
      billTitle: bills.title,
      billPriority: bills.priority,
    })
    .from(calendarEvents)
    .leftJoin(calendarEventBills, eq(calendarEventBills.eventId, calendarEvents.id))
    .leftJoin(bills, eq(bills.id, calendarEventBills.billId))
    .where(
      and(
        ne(calendarEvents.status, 'cancelled'),
        isNotNull(calendarEvents.date),
        gte(calendarEvents.date, todayIso),
        lt(calendarEvents.date, endIso),
        or(
          ne(calendarEvents.source, 'hearing'),
          exists(
            db.select({ _: sql`1` })
              .from(calendarEventBills)
              .innerJoin(bills, eq(bills.id, calendarEventBills.billId))
              .where(and(
                eq(calendarEventBills.eventId, calendarEvents.id),
                isNotNull(bills.priority),
              ))
          ),
        ),
      ),
    )
    .orderBy(calendarEvents.date, calendarEvents.time)
    .all()

  if (rows.length === 0) return  // no events this week — skip without stamping

  // Group rows by event, then events by date
  const eventMap = new Map<string, WeekAheadEvent>()
  const eventDateMap = new Map<string, string>()  // eventId → date
  const dateOrder: string[] = []

  for (const row of rows) {
    if (!eventMap.has(row.eventId)) {
      eventMap.set(row.eventId, {
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
      const d = row.date ?? ''
      eventDateMap.set(row.eventId, d)
      if (d && !dateOrder.includes(d)) dateOrder.push(d)
    }
    const ev = eventMap.get(row.eventId)!
    if (row.billId && !ev.bills.some(b => b.id === row.billId)) {
      ev.bills.push({
        id: row.billId,
        billNumber: row.billNumber ?? '',
        state: row.billState,
        priority: row.billPriority as 'high' | 'medium' | 'low' | null,
        billTitle: row.billTitle,
      })
    }
  }

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

  const icsUrl = `${env.APP_URL}/api/calendar/ics`
  const firstDay = days[0].label.split(', ').slice(1).join(', ')
  const lastDay = days[days.length - 1].label.split(', ').slice(1).join(', ')
  const range = firstDay === lastDay ? firstDay : `${firstDay}–${lastDay}`
  const subject = `${assocName}: Your week ahead — ${range}`
  const html = renderWeekAheadEmail({ days, assocName, appUrl: env.APP_URL, icsUrl })

  const headers = unsubscribeHeaders(env.APP_URL, 'setting-week-ahead')
  await sendBatch(
    env,
    recipients.map(r => ({ to: [r.email], subject, html, headers })),
    'week-ahead',
    db,
  )
  await stampLastWeekAhead(db, nowDb())
}
