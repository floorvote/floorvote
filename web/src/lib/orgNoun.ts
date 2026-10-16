// Display helpers for the configured org noun. The bare noun comes from the
// `/config` API (`orgNoun`), resolved server-side. These build the title-case
// and label forms used in UI copy.
import { DEFAULT_ORG_NOUN, MAX_ORG_NOUN_LENGTH, normalizeOrgNoun } from '../../../shared/orgNoun'

export { DEFAULT_ORG_NOUN, MAX_ORG_NOUN_LENGTH, normalizeOrgNoun }

export function titleCase(noun: string): string {
  return noun ? noun[0].toUpperCase() + noun.slice(1) : ''
}

export function orgPositionLabel(noun: string): string {
  return `${titleCase(noun)} position`
}

export function orgRelevanceLabel(noun: string): string {
  return `${titleCase(noun)} relevance`
}

// Name of the admin settings tab and page for instance-wide email switches.
// Only the first word is capitalized, matching the other settings tabs. The
// noun is run through normalizeOrgNoun (single word, letters only, lowercased,
// default when empty) first, so a noun in lowercase, ALL CAPS, or with a capital
// in the middle ("cOaLiTiOn") reads "Coalition notifications".
export function orgNotificationsLabel(noun?: string | null): string {
  return `${titleCase(normalizeOrgNoun(noun))} notifications`
}

// Header for the custom-roles column, in both the admin Members table and the
// sidebar members popup — shared so the two surfaces cannot drift.
export function orgRolesLabel(noun: string): string {
  return `${titleCase(noun)} roles`
}
