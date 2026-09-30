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

/** A member's status on a date: current while the term covers it. */
export function isCurrentMember(m: { termStart: string | null; termEnd: string | null }, today: string): boolean {
  return (!m.termStart || m.termStart <= today) && (!m.termEnd || m.termEnd >= today)
}
