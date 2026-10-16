/**
 * Serialize filter params the way the bill list writes them to its URL, so a
 * seed's saved-view query is byte-for-byte what a member saving the same filters
 * would store. Repeated keys are repeated pairs: `['tag', 'A'], ['tag', 'B']`.
 */
export const viewQuery = (pairs: Array<[key: string, value: string]>): string =>
  new URLSearchParams(pairs).toString()
