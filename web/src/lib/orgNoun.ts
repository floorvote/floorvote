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

