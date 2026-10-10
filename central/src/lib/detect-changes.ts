import type { CentralMeasure, Provider } from '../providers'
import { statusChangeLabel } from './vocabulary'

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

function sponsorKey(peopleId: number | null | undefined, name: string): string {
  return peopleId ? `p${peopleId}` : `n${name}`
}

function sponsorDetail(sponsor: { role?: string; name: string; party: string }): string {
  const role = sponsor.role ? `${sponsor.role} ` : ''
  return `${role}${sponsor.name} (${sponsor.party})`
}

export function detectChanges(
  snapshot: BillSnapshot,
  bill: CentralMeasure,
  provider: Provider,
): ChangeRecord[] {
  const changes: ChangeRecord[] = []
  const statusLabel = (status: number) => statusChangeLabel(provider, status)

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
