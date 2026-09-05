import { WORD_BOUNDARY_KEYWORDS } from '../../../shared/wordBoundaryKeywords'

export function matchesWordBoundary(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![a-zA-Z])${escaped}`, 'i')
  return re.test(text)
}


/**
 * The wildcard sentinel: a keyword list containing exactly the string "*" means
 * "match every bill". Checked by list membership BEFORE the substring loop, so a
 * bill title that happens to contain an asterisk cannot trigger it and "*extra"
 * stays an ordinary keyword.
 *
 * An EMPTY list still means match-nothing — that is the documented setup state
 * for a new tenant, and the `keywords.length === 0` guards at every call site
 * depend on it. The wildcard is a non-empty list, so it flows past those guards
 * and reaches this function normally.
 */
export const WILDCARD_KEYWORD = '*'

export function matchesUnion(text: string, keywords: string[]): { matched: boolean; keyword: string } {
  if (keywords.includes(WILDCARD_KEYWORD)) return { matched: true, keyword: WILDCARD_KEYWORD }
  const lower = text.toLowerCase()
  for (const kw of keywords) {
    if (WORD_BOUNDARY_KEYWORDS.has(kw)) {
      if (matchesWordBoundary(lower, kw)) return { matched: true, keyword: kw }
    } else {
      if (lower.includes(kw.toLowerCase())) return { matched: true, keyword: kw }
    }
  }
  return { matched: false, keyword: '' }
}
