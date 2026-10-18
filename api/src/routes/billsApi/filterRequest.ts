import { parseBillFilter, type BillFilter } from '../../../../shared/billFilter'
import { MAX_SUBJECT_FILTERS } from '../../../../shared/limits'

/** The 400 body for a bulk request whose `filter` is not a query string. */
export const BULK_FILTER_ERROR = { error: 'filter must be a query string, as GET /bills takes it' }

/**
 * The filter a bulk request carries: a query string in the body's `filter`, the same wire format the list reads,
 * parsed by the same `parseBillFilter`. Null when `filter` is anything but a string (a list of values under each
 * filter's name was the body's old shape, and it is gone). An empty string is the filter with nothing set.
 */
export function parseBulkFilter(filter: unknown): BillFilter | null {
  return typeof filter === 'string' ? parseBillFilter(filter) : null
}

/** The 400 body for a filter naming more subjects than a request may carry, or null when it names no more than that. */
export function subjectCapError(filter: BillFilter): { error: string } | null {
  return filter.subject.length > MAX_SUBJECT_FILTERS
    ? { error: `Too many subject filters. The maximum is ${MAX_SUBJECT_FILTERS}.` }
    : null
}
