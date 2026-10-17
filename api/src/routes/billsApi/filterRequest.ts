import { parseBillFilter, BILL_FILTER_DEFS, CUSTOM_FIELD_KEY_PREFIX, type BillFilter } from '../../../../shared/billFilter'
import { MAX_SUBJECT_FILTERS } from '../../../../shared/limits'

/**
 * The filter a bulk request carries, as its JSON body spells it: each filter under its own name, a multi-select
 * filter as a list, a toggle as `'1'`, `'true'`, or `true`, and the custom fields as `cf`, a list of values per
 * field's slug or id. `billFilterFromBulkBody` reads it as the same bill filter the list reads from a query string.
 */
export type BulkFilterBody = {
  status?: string[]
  stage?: string[]
  priority?: string[]
  position?: string[]
  session?: string[]
  year?: string[]
  state?: string[]
  tag?: string[]
  subject?: string[]
  q?: string
  minRelevance?: string
  myBills?: string | boolean
  unvoted?: string | boolean
  newMatches?: string | boolean
  drafts?: string | boolean
  match?: string
  cf?: Record<string, string[]>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A string or a number, as it prints. */
const text = (v: unknown): string | null => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null

/** A list of values: the strings and numbers of an array, or a lone one as a list of one. A lone value narrows, where dropping it would widen a write. */
function values(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(item => text(item) ?? [])
  const one = text(v)
  return one === null ? [] : [one]
}

/** The value of a single-valued filter: a string, a number, or a boolean (a toggle's `true`), as it prints. */
const scalar = (v: unknown): string | null => typeof v === 'boolean' ? String(v) : text(v)

/**
 * A bulk route's filter body as a bill filter. The body is spelled as a query string would be, and read by
 * `parseBillFilter`, so a body and a query string with the same filters are the same value and select the same
 * bills. Anything that is not a filter is ignored.
 */
export function billFilterFromBulkBody(body: unknown): BillFilter {
  const params = new URLSearchParams()
  if (isRecord(body)) {
    for (const def of BILL_FILTER_DEFS) {
      const raw = body[def.name]
      if (def.kind === 'multi-select') {
        for (const v of values(raw)) params.append(def.name, v)
      } else if (def.kind === 'custom-field') {
        if (!isRecord(raw)) continue
        for (const [field, fieldValues] of Object.entries(raw)) {
          for (const v of values(fieldValues)) params.append(CUSTOM_FIELD_KEY_PREFIX + field, v)
        }
      } else {
        const v = scalar(raw)
        if (v !== null) params.append(def.name, v)
      }
    }
  }
  return parseBillFilter(params)
}

/** The 400 body for a filter naming more subjects than a request may carry, or null when it names no more than that. */
export function subjectCapError(filter: BillFilter): { error: string } | null {
  return filter.subject.length > MAX_SUBJECT_FILTERS
    ? { error: `Too many subject filters. The maximum is ${MAX_SUBJECT_FILTERS}.` }
    : null
}
