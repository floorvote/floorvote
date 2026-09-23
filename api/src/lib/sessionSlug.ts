// Re-export the canonical implementation from shared/. This logic was
// previously duplicated verbatim here, at risk of drifting from the shared
// copy. shared/sessionSlug.ts is now the single source of truth (it also
// exports billUrl, used by web routing).
import { sessionToSlug } from '../../../shared/sessionSlug'

export { sessionToSlug }

/** The slug a bill answers to in /STATE/SLUG/NUMBER.
 *
 *  A draft has no provider session — it is pre-filed, so by definition outside
 *  one — and uses its year instead, which is what makes /UT/2027/D1 work
 *  alongside /UT/2026/HB0209. A filed bill uses its session slug, which is NOT
 *  always its year_start: a biennium row can carry year_start 2025 and a
 *  '2026 Regular Session'. Shared by the resolve routes and the draft-number
 *  collision check so the two agree on what makes two bills ambiguous. */
export function billSlug(b: { session: string; isDraft: boolean; yearStart: number | null }): string {
  return b.isDraft ? String(b.yearStart ?? '') : sessionToSlug(b.session)
}
