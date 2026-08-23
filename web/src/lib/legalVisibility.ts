import { hasTerms, hasPrivacy } from './legalDocs'

/**
 * Whether to surface the operator's legal documents on this tenant.
 *
 * Two independent conditions. `hasTerms`/`hasPrivacy` are build-time: the docs
 * were bundled from `docs/legal/` or they were not, and one build ships to every
 * tenant. `demoMode` is per-tenant and runtime, so it is passed in rather than
 * read here — the three call sites each already have it from a different place
 * (the sidebar from DemoContext, the login page and the document page from
 * `/auth/demo-mode`, which is public), and this keeps the rule itself in one
 * spot regardless.
 *
 * Demo tenants show neither document. Both define the Services as hosted access
 * to "an organization and its registered users," which a demo has none of: every
 * visitor shares one `demo-user` account and one session, on a tenant that
 * resets every six hours. Linking documents that do not govern the reader is the
 * inaccuracy this closes.
 *
 * Note on `DemoContext`'s `settled` flag: it exists because `demoMode === false`
 * is ambiguous before `/config` lands ("not a demo" or "don't know yet"). It is
 * not needed here, because this keys off `demoMode === true`, which is never
 * ambiguous — it is only ever set by a response. The cost is that a demo shows
 * the links for the first render or two, and the alternative is worse: waiting
 * would delay the links on every real tenant, where being conspicuous is the
 * point of having them.
 */
export function legalDocsVisible(demoMode: boolean): { showTerms: boolean; showPrivacy: boolean } {
  return {
    showTerms: hasTerms && !demoMode,
    showPrivacy: hasPrivacy && !demoMode,
  }
}
