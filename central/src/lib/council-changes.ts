import { findPerson, indexPeople, personKey, type LimsPerson } from './lims-map'
import type { CouncilCommittee } from './dccouncil-directory'

/**
 * Council membership over time: linking dccouncil.gov's names to LIMS members,
 * and describing what changed between two syncs.
 *
 * dccouncil.gov names a Councilmember by seat ("Ward 5 Councilmember Zachary
 * Parker", "At-Large Councilmember Robert C. White, Jr."); LIMS names the
 * person ("Robert C. White, Jr.") with an id and term dates. Linking the two
 * lets a roster, a vote, and a term refer to the same person, which is what
 * tells a current member from a former one.
 */

/** The personKey of a dccouncil.gov display name, with the seat stripped. */
export function directoryKey(displayName: string): string {
  return personKey(displayName.replace(/^\s*(ward\s+\d+|at[\s-]*large)\s+/i, ''))
}

export interface LinkedRef { name: string; url: string | null; peopleId: number | null }

/**
 * Resolve each committee chair and member to a LIMS member of the current
 * Council, by name. A name that matches nobody, or matches two people who
 * share a short name, stays unlinked rather than guessed.
 */
export function linkCommittees(committees: CouncilCommittee[], members: LimsPerson[]) {
  const index = indexPeople(members)
  const link = (r: { name: string; url: string | null }): LinkedRef => {
    const p = findPerson(index, r.name.replace(/^\s*(ward\s+\d+|at[\s-]*large)\s+/i, ''))
    return { ...r, peopleId: p?.peopleId ?? null }
  }
  return committees.map(c => ({ ...c, chair: c.chair ? link(c.chair) : null, members: c.members.map(link) }))
}

export interface CouncilChange { kind: string; committee: string | null; person: string | null; detail: string | null }

interface RosterLike {
  name: string
  chair: { name: string } | null
  members: { name: string }[]
  staff: { name: string; title: string | null }[]
}

/** The roster's identity for history: a change here opens a new history row. */
export function rosterSignature(c: RosterLike): string {
  return JSON.stringify([
    c.name,
    c.chair ? directoryKey(c.chair.name) : null,
    c.members.map(m => directoryKey(m.name)).sort(),
    c.staff.map(s => `${directoryKey(s.name)}|${(s.title ?? '').toLowerCase()}`).sort(),
  ])
}

/**
 * What changed between the stored committees and a fresh fetch. `removedSlugs`
 * are committees gone from the Council's index (not ones whose page merely
 * failed to load).
 */
export function diffCommittees(
  before: Map<string, RosterLike>, after: Map<string, RosterLike>, removedSlugs: string[],
): CouncilChange[] {
  const out: CouncilChange[] = []
  for (const [slug, next] of after) {
    const prev = before.get(slug)
    if (!prev) { out.push({ kind: 'committee_added', committee: next.name, person: null, detail: null }); continue }
    const prevChair = prev.chair ? directoryKey(prev.chair.name) : null
    const nextChair = next.chair ? directoryKey(next.chair.name) : null
    if (prevChair !== nextChair) {
      out.push({
        kind: 'chair_changed', committee: next.name, person: next.chair?.name ?? null,
        detail: prev.chair ? `Previously chaired by ${prev.chair.name}.` : null,
      })
    }
    const prevMembers = new Map(prev.members.map(m => [directoryKey(m.name), m.name]))
    const nextMembers = new Map(next.members.map(m => [directoryKey(m.name), m.name]))
    for (const [k, name] of nextMembers) if (!prevMembers.has(k) && k !== nextChair) out.push({ kind: 'member_added', committee: next.name, person: name, detail: null })
    for (const [k, name] of prevMembers) if (!nextMembers.has(k) && k !== nextChair) out.push({ kind: 'member_removed', committee: next.name, person: name, detail: null })
    const prevStaff = new Map(prev.staff.map(s => [directoryKey(s.name), s]))
    const nextStaff = new Map(next.staff.map(s => [directoryKey(s.name), s]))
    for (const [k, s] of nextStaff) {
      const old = prevStaff.get(k)
      if (!old) out.push({ kind: 'staff_added', committee: next.name, person: s.name, detail: s.title })
      else if ((old.title ?? '') !== (s.title ?? '')) out.push({ kind: 'staff_title', committee: next.name, person: s.name, detail: `Now ${s.title ?? 'staff'}${old.title ? `, was ${old.title}` : ''}.` })
    }
    for (const [k, s] of prevStaff) if (!nextStaff.has(k)) out.push({ kind: 'staff_removed', committee: next.name, person: s.name, detail: s.title })
  }
  for (const slug of removedSlugs) {
    const prev = before.get(slug)
    if (prev) out.push({ kind: 'committee_removed', committee: prev.name, person: null, detail: null })
  }
  return out
}

export interface MemberTerm { peopleId: number; name: string; termStart: string | null; termEnd: string | null }

/**
 * Councilmembers sworn in or leaving, from LIMS term dates. `before` is null
 * the first time terms are recorded, which sets a baseline without reporting
 * every sitting member as new.
 */
export function diffTerms(before: Map<number, MemberTerm> | null, after: MemberTerm[], today: string): CouncilChange[] {
  if (!before) return []
  const out: CouncilChange[] = []
  for (const m of after) {
    const prev = before.get(m.peopleId)
    if (!prev) {
      out.push({ kind: 'member_joined', committee: null, person: m.name, detail: m.termStart ? `Term from ${m.termStart}${m.termEnd ? ` to ${m.termEnd}` : ''}.` : null })
      continue
    }
    // A term that now ends earlier than it did, and has ended: a resignation, an expulsion, or an interim seat filled.
    if (m.termEnd && prev.termEnd && m.termEnd < prev.termEnd && m.termEnd <= today) {
      out.push({ kind: 'member_left', committee: null, person: m.name, detail: `Term ended ${m.termEnd}.` })
    }
  }
  return out
}

/**
 * The LIMS member records of the Council Period starting in `yearStart`, one
 * per person. A term that ended by the period's first day belongs to the
 * previous period (CP25 terms end 2025-01-01, CP26 begins 2025-01-02). A
 * member serving in two periods has a record in each, so a name keeps its
 * latest term.
 */
export function periodMembers<T extends { name: string; termStart: string | null; termEnd: string | null }>(all: T[], yearStart: number | null): T[] {
  const first = yearStart ? `${yearStart}-01-01` : null
  const latest = new Map<string, T>()
  for (const m of all) {
    if (first && m.termEnd && m.termEnd <= first) continue
    const k = personKey(m.name)
    const prev = latest.get(k)
    if (!prev || (m.termStart ?? '') > (prev.termStart ?? '')) latest.set(k, m)
  }
  return [...latest.values()]
}

/** Whether LIMS's term dates cover a date. */
export function termCovers(m: { termStart: string | null; termEnd: string | null }, today: string): boolean {
  return (!m.termStart || m.termStart <= today) && (!m.termEnd || m.termEnd >= today)
}

/**
 * A member's status on a date. `seated` is whether dccouncil.gov's
 * Councilmembers page listed the member at the last directory sync (null when
 * not yet checked). The Council's page decides when known, because LIMS term
 * dates lag: after Trayon White was expelled and then re-elected, LIMS still
 * ended his term at the expulsion. Without the page, the LIMS term decides.
 */
export function isCurrentMember(m: { termStart: string | null; termEnd: string | null; seated?: number | null }, today: string): boolean {
  if (m.seated === 1) return true
  if (m.seated === 0) return false
  return termCovers(m, today)
}

/**
 * Where the Council's page and LIMS disagree, a plain note for a page or a
 * brief. Null when they agree or the page has not been checked.
 */
export function seatNote(m: { termStart: string | null; termEnd: string | null; seated?: number | null }, today: string): string | null {
  if (m.seated === 1 && !termCovers(m, today)) {
    return `Listed as serving on dccouncil.gov. LIMS shows the term ${m.termEnd && m.termEnd < today ? `ending ${m.termEnd}` : `starting ${m.termStart}`}.`
  }
  if (m.seated === 0 && termCovers(m, today)) {
    return `Not listed on dccouncil.gov's Councilmembers page. LIMS shows the term to ${m.termEnd ?? 'an open date'}.`
  }
  return null
}

export interface SeatedMember { peopleId: number; name: string; termStart: string | null; termEnd: string | null; seated: number | null }

/**
 * Link the Councilmembers page's names to the current Council Period's LIMS
 * members, and describe changes. Returns null when the page does not look like
 * the Council (too few names link), so the stored status is kept. `members`
 * are the current period's LIMS members, with their stored `seated` values.
 */
export function reconcileSeated(listed: { name: string }[], members: SeatedMember[], today: string):
  { seatedIds: Set<number>; unlinked: string[]; changes: CouncilChange[] } | null {
  const index = indexPeople(members.map(m => ({ peopleId: m.peopleId, name: m.name, role: 'Councilmember' })))
  const seatedIds = new Set<number>()
  const unlinked: string[] = []
  for (const r of listed) {
    const p = findPerson(index, r.name.replace(/^\s*(ward\s+\d+|at[\s-]*large)\s+/i, ''))
    if (p) seatedIds.add(p.peopleId)
    else unlinked.push(r.name)
  }
  if (seatedIds.size < 10) return null
  const changes: CouncilChange[] = []
  for (const m of members) {
    // The first check sets a baseline: no changes until a stored status flips.
    if (m.seated === null) continue
    const now = seatedIds.has(m.peopleId) ? 1 : 0
    if (now === m.seated) continue
    const note = seatNote({ ...m, seated: now }, today)
    if (now === 1) changes.push({ kind: 'member_listed', committee: null, person: m.name, detail: note })
    else changes.push({ kind: 'member_unlisted', committee: null, person: m.name, detail: note })
  }
  return { seatedIds, unlinked, changes }
}
