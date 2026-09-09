/**
 * Re-export of the shared matcher. This file used to carry its own copy of the
 * matching logic, hand-mirrored with central/src/lib/keywords.ts; the two could
 * drift silently, and a drift is serious — central decides which bills to
 * deliver, this Worker decides which to analyze.
 */
export { matchesKeywords, matchesUnion, compileKeyword, WILDCARD_KEYWORD } from '../../../shared/keywords'
