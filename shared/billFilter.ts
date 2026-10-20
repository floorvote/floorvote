// The bill filter: every filter on the Bills page, named once, with one parser and one serializer for the
// web and the API alike. A bill filter is one immutable value that travels as a query string (the URL, a
// saved view, a list request, a facet request), so what one side writes is what the other reads.
//
// Each filter has one name, in the value, the query string, a saved view, the API, and the facets response: the
// search is `search`, a custom field is `field.<slug or id>`, and a session's name is `sessionName`. There are no
// aliases, so a key these filters had before (#699) is ignored like any other unknown key. Each filter has a kind,
// and a kind says how its part of the string reads and writes. The definitions below list every filter in the order
// `serializeBillFilter` writes them, so equal filters give equal strings.

/** The sentinel filter value for "has any value in this filter" (position, priority, tags, a custom field's options). */
export const FILTER_ANY = '__any__'
/** The sentinel filter value for "has no value in this filter" (position and priority). */
export const FILTER_NONE = 'none'

/** The prefix of a custom field's query key: `field.<slug or id>`. */
export const CUSTOM_FIELD_KEY_PREFIX = 'field.'

/** A subject filter value: the subject's name within one state's vocabulary. It travels as `STATE:name`. */
export type SubjectValue = Readonly<{ state: string; name: string }>

/**
 * A subject filter value is `STATE:name`: filter values are namespaced by state because the vocabularies are not
 * comparable across states (New Jersey publishes 44 coarse terms, Arizona 6,449 fine-grained ones), and an
 * unnamespaced "Education" would OR across both. Split on the first colon only, since a name may hold colons.
 * Null when the value is not one.
 */
export function decodeSubjectFilter(value: string): SubjectValue | null {
  const idx = value.indexOf(':')
  if (idx <= 0) return null
  const state = value.slice(0, idx)
  const name = value.slice(idx + 1)
  if (name.length === 0) return null
  return Object.freeze({ state, name })
}

export function encodeSubjectFilter(state: string, name: string): string {
  return `${state}:${name}`
}

export type BillFilter = Readonly<{
  status: readonly string[]
  stage: readonly string[]
  year: readonly string[]
  /** A session's name, as the API stores it. The web has no control for it and drops it. */
  sessionName: readonly string[]
  state: readonly string[]
  position: readonly string[]
  priority: readonly string[]
  tag: readonly string[]
  subject: readonly SubjectValue[]
  /** Central's ids of the committees picked (#471). */
  committee: readonly string[]
  /**
   * What a bill's committee is for the committee filter: `current`, the committee it is pending in, or `any`
   * (the default), any committee it was referred to. A switch on the committee filter, never a filter of its own.
   */
  committeeScope: 'current' | 'any'
  /** The least relevance a bill may have (a whole number), or null for no minimum. Zero is a minimum. */
  minRelevance: number | null
  /** The search query, or an empty string for none. */
  search: string
  myBills: boolean
  unvoted: boolean
  newMatches: boolean
  drafts: boolean
  /** How the bill facts combine: all of them (the default) or any one. */
  match: 'all' | 'any'
  /** The values picked in each custom field, by the field's slug or its id as the query named it. A field with no values is not here. */
  field: Readonly<Record<string, readonly string[]>>
}>

export type BillFilterKind = 'multi-select' | 'toggle' | 'range' | 'text' | 'custom-field'

/**
 * One filter's definition: its kind, its sentinel values, and its part of `parse` (the query string to the
 * filter's value) and of `serialize` (the value to the query string). A filter with no entry in `PARTS`
 * below fails to compile.
 */
type Part<V> = {
  kind: BillFilterKind
  /** The values the filter takes besides its real ones. */
  sentinels: readonly string[]
  read(params: URLSearchParams): V
  write(value: V, out: URLSearchParams): void
}

const frozen = <T extends readonly unknown[]>(items: T): T => Object.freeze(items)

/** A toggle is on for `1` or `true`, and off for anything else. */
const isOn = (value: string | null): boolean => value === '1' || value === 'true'

/** A multi-select filter: every value of a repeated key, in order. */
const multiSelect = (key: string, ...sentinels: string[]): Part<readonly string[]> => ({
  kind: 'multi-select',
  sentinels,
  read: params => frozen(params.getAll(key)),
  write: (values, out) => { for (const v of values) out.append(key, v) },
})

/** A toggle: on is written as `1`. */
const toggle = (key: string): Part<boolean> => ({
  kind: 'toggle',
  sentinels: [],
  read: params => isOn(params.get(key)),
  write: (on, out) => { if (on) out.append(key, '1') },
})

/** Every filter, in the order `serialize` writes them. */
const PARTS: { [K in keyof BillFilter]: Part<BillFilter[K]> } = {
  status: multiSelect('status'),
  stage: multiSelect('stage'),
  year: multiSelect('year'),
  sessionName: multiSelect('sessionName'),
  state: multiSelect('state'),
  position: multiSelect('position', FILTER_ANY, FILTER_NONE),
  priority: multiSelect('priority', FILTER_ANY, FILTER_NONE),
  tag: multiSelect('tag', FILTER_ANY),
  subject: {
    kind: 'multi-select',
    sentinels: [],
    // A value that is not `STATE:name` is dropped. The count is not capped here: a route answers 400 past
    // MAX_SUBJECT_FILTERS (shared/limits), and counts only the valid ones.
    read: params => frozen(params.getAll('subject').flatMap(v => decodeSubjectFilter(v) ?? [])),
    write: (values, out) => { for (const s of values) out.append('subject', encodeSubjectFilter(s.state, s.name)) },
  },
  committee: multiSelect('committee'),
  committeeScope: {
    kind: 'toggle',
    sentinels: [],
    read: params => params.get('committeeScope') === 'current' ? 'current' : 'any',
    write: (scope, out) => { if (scope === 'current') out.append('committeeScope', 'current') },
  },
  minRelevance: {
    kind: 'range',
    sentinels: [],
    read: params => {
      const n = parseInt(params.get('minRelevance') ?? '', 10)
      return Number.isNaN(n) ? null : n
    },
    write: (n, out) => { if (n !== null) out.append('minRelevance', String(n)) },
  },
  search: {
    kind: 'text',
    sentinels: [],
    read: params => params.get('search') ?? '',
    write: (search, out) => { if (search !== '') out.append('search', search) },
  },
  myBills: toggle('myBills'),
  unvoted: toggle('unvoted'),
  newMatches: toggle('newMatches'),
  drafts: toggle('drafts'),
  match: {
    kind: 'toggle',
    sentinels: [],
    read: params => params.get('match') === 'any' ? 'any' : 'all',
    write: (match, out) => { if (match === 'any') out.append('match', 'any') },
  },
  field: {
    kind: 'custom-field',
    sentinels: [FILTER_ANY],
    // A key read from a URL may be any text, including one that names a member of Object.prototype, so the
    // fields are gathered in a Map and built into an object by defining each key as an own property.
    read: params => {
      const fields = new Map<string, string[]>()
      for (const [key, value] of params) {
        if (!key.startsWith(CUSTOM_FIELD_KEY_PREFIX)) continue
        const name = key.slice(CUSTOM_FIELD_KEY_PREFIX.length)
        const values = fields.get(name)
        if (values) values.push(value)
        else fields.set(name, [value])
      }
      return Object.freeze(Object.fromEntries([...fields].map(([name, values]) => [name, frozen(values)])))
    },
    // By key, so a filter built in any order writes the same string.
    write: (field, out) => {
      for (const name of Object.keys(field).sort()) for (const v of field[name]) out.append(CUSTOM_FIELD_KEY_PREFIX + name, v)
    },
  },
}

const NAMES = Object.keys(PARTS) as Array<keyof BillFilter>
const part = (name: keyof BillFilter) => PARTS[name] as Part<unknown>

export type BillFilterDef = Readonly<{
  /** The filter's key in the value and, but for a custom field's `field.<key>`, in the query string. */
  name: keyof BillFilter
  kind: BillFilterKind
  /** The values the filter takes besides its real ones. */
  sentinels: readonly string[]
}>

/** Every filter, with its kind and its sentinels, in the order `serializeBillFilter` writes them. */
export const BILL_FILTER_DEFS: readonly BillFilterDef[] = Object.freeze(
  NAMES.map(name => Object.freeze({ name, kind: PARTS[name].kind, sentinels: frozen([...PARTS[name].sentinels]) })),
)

/** The filter with nothing set. */
export const EMPTY_BILL_FILTER: BillFilter = parseBillFilter('')

/**
 * A query string (or its search params) as a bill filter. Unknown keys and values are ignored. A repeated
 * key gives a multi-select filter every value, in order, and any other filter its first. The result is
 * immutable, and every part of it is too.
 */
export function parseBillFilter(input: string | URLSearchParams): BillFilter {
  const params = typeof input === 'string' ? new URLSearchParams(input) : input
  const value: Record<string, unknown> = {}
  for (const name of NAMES) value[name] = part(name).read(params)
  return Object.freeze(value) as BillFilter
}

/**
 * A bill filter as a query string. Keys are written in one order, whatever order the filter was built or
 * read in (a filter's values keep theirs, as a chip row shows them as picked), so equal filters give equal
 * strings. A toggle that is on is written as `1`, and a filter that is not set is not written.
 */
export function serializeBillFilter(filter: BillFilter): string {
  const out = new URLSearchParams()
  for (const name of NAMES) part(name).write(filter[name], out)
  return out.toString()
}

/**
 * A bill filter with some parts set: the parts of `patch` laid over `base`, which is the filter with nothing set unless
 * a filter is given. The result is immutable, and neither argument is changed.
 */
export function withBillFilter(patch: Partial<BillFilter>, base: BillFilter = EMPTY_BILL_FILTER): BillFilter {
  return Object.freeze({ ...base, ...patch })
}

/**
 * The path of the Bills page filtered as `patch` says (`/bills?priority=high`), or `/bills` for a filter that sets
 * nothing. Every link to a filtered list builds its URL here, so a link is written by the same `serializeBillFilter`
 * the page writes its own URL with.
 */
export function billsListPath(patch: Partial<BillFilter> = {}): string {
  const query = serializeBillFilter(withBillFilter(patch))
  return query === '' ? '/bills' : `/bills?${query}`
}

/**
 * One filter that has a value: its name, its key (a custom field's is `field.<key>`), and how many values it holds.
 * The stage is never a name here: it is a grouping inside Status, so its values are listed under `status`.
 */
export type ActiveFilter = Readonly<{ name: Exclude<keyof BillFilter, 'match' | 'stage' | 'committeeScope'>; key: string; count: number }>

const distinct = (values: readonly string[]): number => new Set(values).size

/** How many values a filter holds, each distinct value once. A toggle, a minimum, and a search hold one when set. */
function countValues(filter: BillFilter, name: Exclude<keyof BillFilter, 'match' | 'stage' | 'committeeScope' | 'field'>): number {
  const value = filter[name]
  if (Array.isArray(value)) {
    return name === 'subject'
      ? distinct((value as readonly SubjectValue[]).map(s => encodeSubjectFilter(s.state, s.name)))
      : distinct(value as readonly string[])
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return 1
  if (typeof value === 'string') return value.trim() === '' ? 0 : 1
  return 0
}

/**
 * The one list of active filters: every filter with a value, search included, in the order `serializeBillFilter`
 * writes them, with a custom field once per field. The match mode and the committee scope are not filters and are never in it. The badge,
 * Reset, the chips, the filter sheet, and the split pane's summary all read this list, so none counts for itself.
 * A filter named in `hidden` (one this instance does not offer) is left out.
 */
export function activeFilters(filter: BillFilter, options: { hidden?: readonly string[] } = {}): readonly ActiveFilter[] {
  const hidden = options.hidden ?? []
  const list: ActiveFilter[] = []
  for (const { name } of BILL_FILTER_DEFS) {
    if (name === 'match' || name === 'committeeScope' || hidden.includes(name)) continue
    if (name === 'field') {
      for (const [key, values] of Object.entries(filter.field)) {
        const count = distinct(values)
        if (count > 0) list.push({ name, key: CUSTOM_FIELD_KEY_PREFIX + key, count })
      }
      continue
    }
    // The stage is one way of choosing statuses (a heading selects a whole stage), and on the server the two are one fact,
    // so the list holds one Status entry for both and each value counts once (#677).
    if (name === 'stage') continue
    const count = countValues(filter, name) + (name === 'status' ? distinct(filter.stage) : 0)
    if (count > 0) list.push({ name, key: name, count })
  }
  return Object.freeze(list)
}

/** The badge's number: the values in the list. A search is in the list but is not counted, as it is not a value picked. */
export function activeFilterCount(active: readonly ActiveFilter[]): number {
  return active.reduce((sum, a) => (a.name === 'search' ? sum : sum + a.count), 0)
}
