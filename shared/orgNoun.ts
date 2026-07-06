// Single source of truth for a tenant's self-noun ("team" / "association" /
// "coalition" / custom). Stored in association_config under `org_noun`. The
// resolver falls back to the legacy `position_label` first word so existing
// tenants keep their noun with no migration.
export const DEFAULT_ORG_NOUN = 'team'

// A noun is a single word; cap its length so a pasted essay (or junk) can't be
// stored and rendered into UI copy / email. ~12 chars covers real nouns
// ("organization"); 32 is a generous ceiling.
export const MAX_ORG_NOUN_LENGTH = 32

export function firstWord(s: string): string {
  return s.trim().split(/\s+/)[0] ?? ''
}

// Reduce arbitrary input to a safe single-word noun: first whitespace token,
// letters only (drops digits, punctuation, markup, emoji — so it can't break
// layout or inject markup), lowercased, length-capped. Falls back to the
// default when nothing usable remains.
export function normalizeOrgNoun(raw: string | null | undefined): string {
  const w = firstWord(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}]/gu, '')
    .slice(0, MAX_ORG_NOUN_LENGTH)
  return w || DEFAULT_ORG_NOUN
}

export function resolveOrgNoun(
  orgNounRaw?: string | null,
  positionLabelRaw?: string | null,
): string {
  if (orgNounRaw && orgNounRaw.trim()) return normalizeOrgNoun(orgNounRaw)
  if (positionLabelRaw && positionLabelRaw.trim()) return normalizeOrgNoun(positionLabelRaw)
  return DEFAULT_ORG_NOUN
}
