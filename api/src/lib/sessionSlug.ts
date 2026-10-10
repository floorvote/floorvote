// Re-export the canonical implementation from shared/. This logic was
// previously duplicated verbatim here, at risk of drifting from the shared
// copy. shared/sessionSlug.ts is now the single source of truth (it also
// exports billUrl, used by web routing).
import { legacySessionSlug, sessionToSlug } from '../../../shared/sessionSlug'

export { legacySessionSlug, sessionToSlug }

/** The slug a filed bill's URL uses: the one central assigned its session,
 *  which is unique within the state, or, for a bill stored before central sent
 *  one, the one its session name asks for. Null when there is neither. */
export function filedSlug(b: { session: string | null; sessionSlug: string | null }): string | null {
  return b.sessionSlug ?? (b.session ? sessionToSlug(b.session) : null)
}

/** The slug a bill answers to in /STATE/SLUG/NUMBER.
 *
 *  A draft has no provider session — it is pre-filed, so by definition outside
 *  one — and uses its year instead, which is what makes /UT/2027/D1 work
 *  alongside /UT/2026/HB0209. A filed bill uses its session slug (filedSlug),
 *  which is NOT always its year_start: a biennium row can carry year_start 2025
 *  and a '2026 Regular Session'. Shared by the resolve routes and the
 *  draft-number collision check so the two agree on what makes two bills
 *  ambiguous. */
export function billSlug(b: { session: string; sessionSlug: string | null; isDraft: boolean; yearStart: number | null }): string {
  return b.isDraft ? String(b.yearStart ?? '') : (filedSlug(b) ?? '')
}
