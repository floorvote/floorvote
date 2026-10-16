// Stub for red tests (#571).
export type Span = { start: number; end: number }
export type ClaimSourceStatus = 'exact' | 'normalized' | 'fuzzy' | 'anchored' | 'ungrounded' | 'unverified'
export type ClaimSourceItem = { claim: string; status: ClaimSourceStatus; quoteAt?: Span; matched?: string }
export type ClaimDocument = { docId: string; type: string; date: string; mime: string; stateLink: string | null; altStateLink: string | null }
export type ClaimSourcesDetail = { billId: string; document: ClaimDocument; items: ClaimSourceItem[] }
export type ClaimLink = { index: number; claim: string; quoteAt: Span; matched: string }
export const PASSAGE_ID = 'fv-claim-passage'

export function linkableClaims(_cs: ClaimSourcesDetail | null | undefined, _enabled: boolean | undefined): ClaimLink[] {
  return []
}

export function linkClaimsInHtml(html: string, _claims: readonly { index: number; claim: string }[]): string {
  return html
}

export function markPassage(_html: string, _passage: { matched: string; quoteAt: Span }): string | null {
  return null
}
