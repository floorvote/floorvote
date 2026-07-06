import { and, eq, gte, lte, isNotNull, asc } from 'drizzle-orm'
import { calendarEvents, bills } from '../db/schema'
import type { getDb } from '../db/client'

type Db = ReturnType<typeof getDb>

const LEGISCAN_PREFIX = 'legiscan:'

const todayISO = () => new Date().toISOString().slice(0, 10)
const addDaysISO = (baseISO: string, n: number) =>
  new Date(new Date(`${baseISO}T00:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10)

/**
 * A row shaped like central's `/tenants/:id/upcoming-hearings` response, built from the
 * tenant `calendar_events` table. Lets `fetchUpcomingHearings` reuse its existing grouping
 * logic unchanged in DEMO_MODE.
 */
export interface UpcomingHearingRow {
  eventHash: string
  type: string | null
  date: string
  time: string | null
  location: string | null
  description: string | null
  billId: number
  billNumber: string
  billTitle: string
  state: string | null
  sessionName: string | null
}

/**
 * DEMO ONLY. Confirmed `source='hearing'` events within `[today, today+days]`, joined to
 * their LegiScan bill. `billId` is the integer parsed from `external_id` ('legiscan:<n>')
 * so downstream code can re-key via `legiscan:<billId>`.
 */
export async function loadUpcomingDemoHearings(db: Db, days: number): Promise<UpcomingHearingRow[]> {
  const today = todayISO()
  const end = addDaysISO(today, days)
  const rows = await db
    .select({
      eventHash: calendarEvents.eventHash,
      date: calendarEvents.date,
      time: calendarEvents.time,
      location: calendarEvents.location,
      description: calendarEvents.description,
      externalId: bills.externalId,
      billNumber: bills.billNumber,
      billTitle: bills.title,
      state: bills.state,
      sessionName: bills.session,
    })
    .from(calendarEvents)
    .innerJoin(bills, eq(calendarEvents.billId, bills.id))
    .where(and(
      eq(calendarEvents.source, 'hearing'),
      eq(calendarEvents.status, 'confirmed'),
      isNotNull(calendarEvents.date),
      gte(calendarEvents.date, today),
      lte(calendarEvents.date, end),
      isNotNull(bills.externalId),
    ))
    .orderBy(asc(calendarEvents.date))
    .all()

  return rows.flatMap((r) => {
    const ext = r.externalId ?? ''
    if (!ext.startsWith(LEGISCAN_PREFIX)) return []
    const billId = Number(ext.slice(LEGISCAN_PREFIX.length))
    if (!Number.isFinite(billId)) return []
    return [{
      eventHash: r.eventHash ?? '',
      type: 'Hearing',
      date: r.date as string,
      time: r.time,
      location: r.location,
      description: r.description,
      billId,
      billNumber: r.billNumber,
      billTitle: r.billTitle,
      state: r.state,
      sessionName: r.sessionName,
    }]
  })
}

/** An entry shaped like `CentralBillRich['calendar'][number]` in billsApi.ts. */
export interface DemoBillCalendarEntry {
  eventHash: string
  typeId: number
  type: string
  date: string
  time: string | null
  location: string | null
  description: string | null
}

/**
 * DEMO ONLY. A single bill's confirmed `source='hearing'` events (any date), shaped to
 * replace `centralRich.calendar` on the bill detail page.
 */
export async function loadDemoBillCalendar(db: Db, billId: string): Promise<DemoBillCalendarEntry[]> {
  const rows = await db
    .select({
      eventHash: calendarEvents.eventHash,
      date: calendarEvents.date,
      time: calendarEvents.time,
      location: calendarEvents.location,
      description: calendarEvents.description,
    })
    .from(calendarEvents)
    .where(and(
      eq(calendarEvents.billId, billId),
      eq(calendarEvents.source, 'hearing'),
      eq(calendarEvents.status, 'confirmed'),
      isNotNull(calendarEvents.date),
    ))
    .orderBy(asc(calendarEvents.date))
    .all()

  return rows.map((r) => ({
    eventHash: r.eventHash ?? '',
    typeId: 0,
    type: 'Hearing',
    date: r.date as string,
    time: r.time,
    location: r.location,
    description: r.description,
  }))
}
