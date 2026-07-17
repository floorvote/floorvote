/**
 * The operator's legal documents, bundled at build time from the repo-root
 * `docs/legal/` via the `virtual:legal-docs` module (see the `legal-docs` plugin
 * in web/vite.config.ts, which reads the files with Node fs). Real-named files
 * (`TERMS OF USE.md` / `PRIVACY POLICY.md`) are gitignored until launch, so most
 * builds resolve to nothing and the /terms + /privacy routes and the footer/login
 * legal links simply don't render. Only `*.example.md` placeholders ship upstream.
 */
import { terms, privacy } from 'virtual:legal-docs'

export interface LegalDocs {
  terms: string | null
  privacy: string | null
}

export const legalDocs: LegalDocs = { terms, privacy }
export const hasTerms = legalDocs.terms !== null
export const hasPrivacy = legalDocs.privacy !== null
