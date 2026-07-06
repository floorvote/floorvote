// Re-export the canonical implementation from shared/. This logic was
// previously duplicated verbatim here, at risk of drifting from the shared
// copy. shared/sessionSlug.ts is now the single source of truth (it also
// exports billUrl, used by web routing).
export { sessionToSlug } from '../../../shared/sessionSlug'
