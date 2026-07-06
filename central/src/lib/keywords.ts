export function matchesWordBoundary(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![a-zA-Z])${escaped}`, 'i')
  return re.test(text)
}

const WORD_BOUNDARY_KEYWORDS = new Set(['election'])

export function matchesUnion(text: string, keywords: string[]): { matched: boolean; keyword: string } {
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
