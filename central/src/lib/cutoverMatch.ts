/**
 * How a cutover (lib/cutover.ts) matches a state's bills and legislators
 * across two providers. Pure functions, so the dry run and the cutover itself
 * match the same way.
 */

/** "HB0001" → "HB1", "B26-0400" → "B26-400": bill numbers compared without padding or spaces. */
export function comparableNumber(n: string): string {
  return n.toUpperCase().replace(/\s+/g, '').replace(/(^|\D)0+(?=\d)/g, '$1')
}

/**
 * The key a bill is matched on: its session's first year, whether the session
 * is special, and its number. Two providers name sessions differently, but
 * agree on these. A key two bills on one side share matches neither, since
 * there's no telling which is which (two special sessions in one year, say).
 */
export function billMatchKey(session: { yearStart: number; special: number }, number: string): string {
  return `${session.yearStart}|${session.special ? 1 : 0}|${comparableNumber(number)}`
}

/** One legislator, as either provider describes them. */
export interface PersonFacts {
  id: number
  name: string
  firstName?: string | null
  lastName?: string | null
  role?: string | null
  roleId?: number | null
  district?: string | null
}

/** What two people's records agreed on, beyond their state. */
export type MatchedOn = 'name' | 'chamber' | 'district'

export interface PersonMatch<A extends PersonFacts, B extends PersonFacts> {
  from: A
  to: B
  /** How closely the names agreed: whole first and last names, last name and first initial, or last name alone. */
  name: 'full' | 'initial' | 'last'
  on: MatchedOn[]
  /** Not confirmed by chamber and district both, such as a match on names alone. */
  weak: boolean
}

export interface PeopleMatch<A extends PersonFacts, B extends PersonFacts> {
  matched: PersonMatch<A, B>[]
  /** New people with more than one equally good candidate, left unmatched. */
  ambiguous: { person: B; candidates: A[] }[]
  unmatchedFrom: A[]
  unmatchedTo: B[]
}

const TITLE = /^(?:the honorable|honorable|hon|delegate|del|senator|sen|representative|rep|assemblymember|assemblyman|assemblywoman|councilmember|council member|chairman|chairwoman|chairperson|chair|mr|mrs|ms|dr)\.?\s+/i
const SUFFIX = /,?\s+(?:jr|sr|ii|iii|iv)\.?$/i

function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/"[^"]*"|\([^)]*\)/g, ' ')   // nicknames
    .replace(/-/g, ' ')
    .replace(/[^a-z\s,]/g, '')
    .replace(/\s+/g, ' ').trim()
}

const lastToken = (s: string) => s.split(' ').filter(Boolean).at(-1) ?? ''
const firstToken = (s: string) => s.split(' ').filter(Boolean)[0] ?? ''

/** A person's last name, and first name or initial (null when the record gives neither), folded for comparison. */
export function nameParts(p: PersonFacts): { first: string | null; last: string } {
  if (p.lastName && fold(p.lastName)) {
    return { last: lastToken(fold(p.lastName).replace(/,/g, '')), first: firstToken(fold(p.firstName ?? '').replace(/,/g, '')) || null }
  }
  let name = p.name.trim()
  for (let prev = ''; prev !== name;) { prev = name; name = name.replace(TITLE, '') }
  name = fold(name.replace(SUFFIX, ''))
  const comma = name.indexOf(',')
  if (comma >= 0) {
    return { last: lastToken(name.slice(0, comma)), first: firstToken(name.slice(comma + 1).replace(/,/g, '')) || null }
  }
  const tokens = name.split(' ').filter(Boolean)
  return { last: tokens.at(-1) ?? '', first: tokens.length > 1 ? tokens[0] : null }
}

/** 'upper' or 'lower' from a role id (LegiScan's 1 and 2) or a role's title, or null for a unicameral body or no role. */
export function chamberOf(p: PersonFacts): 'upper' | 'lower' | null {
  if (p.roleId === 1) return 'lower'
  if (p.roleId === 2) return 'upper'
  const role = (p.role ?? '').toLowerCase()
  if (/^(rep|del|assembly|house)/.test(role)) return 'lower'
  if (/^sen/.test(role)) return 'upper'
  return null
}

/** "HD-012" → "12", "Ward 1" → "1", or the folded text when there's no number. Null when blank. */
export function districtOf(p: PersonFacts): string | null {
  const d = (p.district ?? '').trim().toLowerCase()
  if (!d) return null
  const m = /(\d+)([a-z]?)\s*$/.exec(d)
  return m ? `${Number(m[1])}${m[2]}` : d.replace(/[^a-z0-9]/g, '')
}

type Tier = PersonMatch<PersonFacts, PersonFacts>['name']

function sameName(tier: Tier, a: { first: string | null; last: string }, b: { first: string | null; last: string }): boolean {
  if (!a.last || a.last !== b.last) return false
  if (tier === 'full') return !!a.first && !!b.first && a.first.length > 1 && a.first === b.first
  if (tier === 'initial') return !!a.first && !!b.first && a.first[0] === b.first[0]
  return !a.first || !b.first
}

/**
 * Match legislators across two providers of one state, on name, chamber, and
 * district: each compared only where both records have it, and any that
 * disagree rule a pair out. Names are tried closest first (whole names, then
 * last name and first initial, then last name alone where a record has no
 * first name), and a pair counts only when each is the other's one candidate,
 * so two Smiths in one chamber match no one. Maryland's feed names members by
 * last name alone and Virginia's has no districts, so their matches are weak:
 * reported as such, and still kept.
 */
export function matchPeople<A extends PersonFacts, B extends PersonFacts>(from: A[], to: B[]): PeopleMatch<A, B> {
  const facts = new Map<PersonFacts, { names: { first: string | null; last: string }; chamber: string | null; district: string | null }>()
  for (const p of [...from, ...to]) facts.set(p, { names: nameParts(p), chamber: chamberOf(p), district: districtOf(p) })
  const compatible = (a: PersonFacts, b: PersonFacts) => {
    const fa = facts.get(a)!, fb = facts.get(b)!
    return (!fa.chamber || !fb.chamber || fa.chamber === fb.chamber)
      && (!fa.district || !fb.district || fa.district === fb.district)
  }
  const related = (tier: Tier, a: PersonFacts, b: PersonFacts) => sameName(tier, facts.get(a)!.names, facts.get(b)!.names) && compatible(a, b)

  const freeFrom = new Set(from)
  const freeTo = new Set(to)
  const matched: PersonMatch<A, B>[] = []
  const ambiguous: PeopleMatch<A, B>['ambiguous'] = []
  for (const tier of ['full', 'initial', 'last'] as const) {
    for (const person of [...freeTo]) {
      const candidates = [...freeFrom].filter(o => related(tier, o, person))
      if (candidates.length === 0) continue
      const other = candidates.length === 1 ? [...freeTo].filter(n => related(tier, candidates[0], n)) : []
      if (candidates.length > 1 || other.length > 1) {
        ambiguous.push({ person, candidates: candidates.length > 1 ? candidates : [candidates[0]] })
        freeTo.delete(person)
        continue
      }
      const o = candidates[0]
      const fo = facts.get(o)!, fp = facts.get(person)!
      const on: MatchedOn[] = ['name']
      if (fo.chamber && fp.chamber) on.push('chamber')
      if (fo.district && fp.district) on.push('district')
      matched.push({ from: o, to: person, name: tier, on, weak: !(on.includes('chamber') && on.includes('district')) })
      freeFrom.delete(o)
      freeTo.delete(person)
    }
  }
  return { matched, ambiguous, unmatchedFrom: [...freeFrom], unmatchedTo: [...freeTo] }
}
