/**
 * Build-time import of the operator's legal documents. Real-named files
 * (`TERMS OF USE.md` / `PRIVACY POLICY.md`) are gitignored until launch, so in
 * most builds this resolves to nothing and the /terms + /privacy routes and the
 * footer legal links simply don't render. Only `*.example.md` placeholders ship
 * upstream; the glob excludes them.
 */

export interface LegalDocs {
  terms: string | null
  privacy: string | null
}

/**
 * Pure resolver: pick the terms/privacy markdown out of a raw glob result,
 * matching on the (space-separated, uppercase) filename regardless of the
 * absolute glob-key path.
 */
export function resolveLegalDocs(raw: Record<string, string>): LegalDocs {
  const find = (needle: string): string | null => {
    const hit = Object.entries(raw).find(([path]) => path.toLowerCase().includes(needle))
    return hit ? hit[1] : null
  }
  return { terms: find('terms of use'), privacy: find('privacy policy') }
}

// `@legal` → repo-root docs/legal (see vite.config.ts). Vite permits alias paths
// in glob patterns; the pattern and options must be literals. `!(*.example)`
// excludes the placeholder files.
const raw = import.meta.glob('@legal/!(*.example).md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

export const legalDocs: LegalDocs = resolveLegalDocs(raw)
export const hasTerms = legalDocs.terms !== null
export const hasPrivacy = legalDocs.privacy !== null
