import type { LegiscanBill, LegiscanCalendarEntry } from './legiscan'
import type { CalendarBlock } from '../types-legiscan'

export type ChangeRecord = {
  changeType:
    | 'status_change'
    | 'title_changed'
    | 'description_changed'
    | 'action_added'
    | 'text_added'
    | 'amendment_added'
    | 'supplement_added'
    | 'sponsor_added'
    | 'sponsor_removed'
    | 'vote_added'
  oldValue: string | null
  newValue: string | null
  detail: string | null
}

export type BillSnapshot = {
  status: number | null
  title: string
  description: string | null
  /** Count of history entries last seen — new entries are those beyond this index */
  latestHistoryCount: number
  textDocIds: Set<number>
  supplementIds: Set<number>
  amendmentIds: Set<number>
  voteIds: Set<number>
  /** `p${peopleId}` when peopleId is truthy, `n${name}` otherwise */
  sponsorKeys: Set<string>
  /** key → "Role Name (Party)" — used as oldValue when a sponsor is removed */
  sponsorDetailByKey: Map<string, string>
}

const STATUS_LABELS: Record<number, string> = {
  0: 'Pre-filed',
  1: 'Introduced',
  2: 'Engrossed',
  3: 'Enrolled',
  4: 'Passed',
  5: 'Vetoed',
  6: 'Failed/Dead',
}

function statusLabel(status: number): string {
  return STATUS_LABELS[status] ?? String(status)
}

function sponsorKey(peopleId: number | null | undefined, name: string): string {
  return peopleId ? `p${peopleId}` : `n${name}`
}

function sponsorDetail(sponsor: { role?: string; name: string; party: string }): string {
  const role = sponsor.role ? `${sponsor.role} ` : ''
  return `${role}${sponsor.name} (${sponsor.party})`
}

export function detectChanges(snapshot: BillSnapshot, bill: LegiscanBill): ChangeRecord[] {
  const changes: ChangeRecord[] = []

  // 1. Status change (skip when snapshot.status is null — bill is new/unknown)
  if (snapshot.status !== null && bill.status !== snapshot.status) {
    changes.push({
      changeType: 'status_change',
      oldValue: statusLabel(snapshot.status),
      newValue: statusLabel(bill.status),
      detail: null,
    })
  }

  // 2. Title changed
  if (bill.title !== snapshot.title) {
    changes.push({
      changeType: 'title_changed',
      oldValue: snapshot.title,
      newValue: bill.title,
      detail: null,
    })
  }

  // 3. Description changed (normalize empty string to null)
  const incomingDesc = bill.description || null
  const snapshotDesc = snapshot.description || null
  if (incomingDesc !== snapshotDesc) {
    changes.push({
      changeType: 'description_changed',
      oldValue: snapshotDesc,
      newValue: incomingDesc,
      detail: null,
    })
  }

  // 4. Action added — new history entries beyond the count we last saw
  if (bill.history.length > snapshot.latestHistoryCount) {
    const newEntries = bill.history.slice(snapshot.latestHistoryCount)
    // Report only the most recent new action — multiple new steps arriving between hourly
    // cron ticks is rare, and showing the latest is more useful than flooding the change log.
    const latestNew = newEntries[newEntries.length - 1]
    changes.push({
      changeType: 'action_added',
      oldValue: null,
      newValue: latestNew.action,
      detail: latestNew.date,
    })
  }

  // 5. Text added (new doc_ids only)
  for (const text of bill.texts) {
    if (!snapshot.textDocIds.has(text.doc_id)) {
      changes.push({
        changeType: 'text_added',
        oldValue: null,
        newValue: String(text.doc_id),
        detail: text.type,
      })
    }
  }

  // 6. Amendment added
  for (const amendment of bill.amendments) {
    if (!snapshot.amendmentIds.has(amendment.amendment_id)) {
      changes.push({
        changeType: 'amendment_added',
        oldValue: null,
        newValue: String(amendment.amendment_id),
        detail: amendment.title || null,
      })
    }
  }

  // 7. Supplement added
  for (const supplement of bill.supplements) {
    if (!snapshot.supplementIds.has(supplement.supplement_id)) {
      changes.push({
        changeType: 'supplement_added',
        oldValue: null,
        newValue: String(supplement.supplement_id),
        detail: supplement.type || null,
      })
    }
  }

  // 8. Sponsor added / 9. Sponsor removed
  const incomingSponsorKeys = new Set<string>()
  for (const sponsor of bill.sponsors) {
    const key = sponsorKey(sponsor.people_id, sponsor.name)
    incomingSponsorKeys.add(key)
    if (!snapshot.sponsorKeys.has(key)) {
      changes.push({
        changeType: 'sponsor_added',
        oldValue: null,
        newValue: sponsorDetail(sponsor),
        detail: null,
      })
    }
  }
  for (const key of snapshot.sponsorKeys) {
    if (!incomingSponsorKeys.has(key)) {
      const detail = snapshot.sponsorDetailByKey.get(key) ?? key
      changes.push({
        changeType: 'sponsor_removed',
        oldValue: detail,
        newValue: null,
        detail: null,
      })
    }
  }

  // 10. Vote added
  for (const vote of bill.votes) {
    if (!snapshot.voteIds.has(vote.roll_call_id)) {
      changes.push({
        changeType: 'vote_added',
        oldValue: null,
        newValue: String(vote.roll_call_id),
        detail: vote.desc || null,
      })
    }
  }

  return changes
}

export type CalendarChange = {
  changeType: 'hearing_added' | 'hearing_changed' | 'hearing_cancelled'
  identityKey: string
  date: string | null
  time: string | null
  location: string | null
  description: string | null
  /** Current event_hash for added/changed; the prior (stale) hash for cancelled. */
  eventHash: string | null
}

export type PriorCalendarRow = {
  identityKey: string
  eventHash: string | null
  date: string | null
  description: string | null
  time: string | null
  location: string | null
}

function normalizeDesc(desc: string | null | undefined): string {
  return (desc ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

// Stable identity for a calendar entry within a bill. event_hash is a version
// marker, NOT identity — so a date/time move under the same identity reads as a
// change, not a cancel+add. Falls back to date when description is blank.
export function calendarIdentityKey(entry: { type_id: number | null; description: string | null; date: string | null }): string {
  const desc = normalizeDesc(entry.description)
  const tail = desc || `date:${entry.date ?? ''}`
  return `${entry.type_id || 'x'}|${tail}`
}

function isPast(date: string | null, today: string): boolean {
  return !!date && date < today
}

export function detectCalendarChanges(
  prior: PriorCalendarRow[],
  incoming: LegiscanCalendarEntry[],
  today: string,
): CalendarChange[] {
  const priorByKey = new Map(prior.map(p => [p.identityKey, p]))
  const incomingKeys = new Set<string>()
  const changes: CalendarChange[] = []

  for (const entry of incoming) {
    const key = calendarIdentityKey(entry)
    incomingKeys.add(key)
    const priorRow = priorByKey.get(key)
    if (!priorRow) {
      changes.push({
        changeType: 'hearing_added', identityKey: key,
        date: entry.date || null, time: entry.time || null,
        location: entry.location || null, description: entry.description || null,
        eventHash: entry.event_hash || null,
      })
    } else if ((priorRow.eventHash ?? '') !== (entry.event_hash ?? '')) {
      const suppressedAsPast = isPast(entry.date || null, today)
      const diff: Record<string, [unknown, unknown]> = {}
      if ((priorRow.date ?? '') !== (entry.date ?? '')) diff.date = [priorRow.date, entry.date]
      if ((priorRow.time ?? '') !== (entry.time ?? '')) diff.time = [priorRow.time, entry.time]
      if ((priorRow.location ?? '') !== (entry.location ?? '')) diff.location = [priorRow.location, entry.location]
      if ((priorRow.description ?? '') !== (entry.description ?? '')) diff.description = [priorRow.description, entry.description]
      console.log('[calendar-change] hearing_changed', JSON.stringify({
        identityKey: key,
        oldHash: priorRow.eventHash, newHash: entry.event_hash || null,
        date: entry.date || null, diff, suppressedAsPast,
      }))
      if (!suppressedAsPast) {
        changes.push({
          changeType: 'hearing_changed', identityKey: key,
          date: entry.date || null, time: entry.time || null,
          location: entry.location || null, description: entry.description || null,
          eventHash: entry.event_hash || null,
        })
      }
    }
  }

  for (const priorRow of prior) {
    if (!incomingKeys.has(priorRow.identityKey) && !isPast(priorRow.date, today)) {
      changes.push({
        changeType: 'hearing_cancelled', identityKey: priorRow.identityKey,
        date: priorRow.date, time: null, location: null,
        description: priorRow.description, eventHash: priorRow.eventHash,
      })
    }
  }

  return changes
}

export type StoredCalendarRow = {
  typeId: number | null
  description: string | null
  date: string | null
  time: string | null
  location: string | null
  eventHash: string | null
}

export function calendarBlockFromRows(rows: StoredCalendarRow[]): CalendarBlock {
  return {
    events: rows.map(r => ({
      identityKey: calendarIdentityKey({ type_id: r.typeId, description: r.description, date: r.date }),
      date: r.date,
      time: r.time,
      location: r.location,
      description: r.description,
      eventHash: r.eventHash,
    })),
    changes: [],
  }
}
