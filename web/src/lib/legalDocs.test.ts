import { describe, it, expect } from 'vitest'
import { legalDocs, hasTerms, hasPrivacy } from './legalDocs'

// Exercises that `virtual:legal-docs` resolves through the Vite/vitest plugin
// pipeline and that the flags derive from the loaded content. The actual content
// is environment-dependent (present locally, absent in CI), so assertions stay on
// the invariant relationship rather than concrete values.
describe('legalDocs', () => {
  it('exposes string-or-null content for each doc', () => {
    expect(legalDocs.terms === null || typeof legalDocs.terms === 'string').toBe(true)
    expect(legalDocs.privacy === null || typeof legalDocs.privacy === 'string').toBe(true)
  })

  it('derives hasTerms/hasPrivacy from whether the content is present', () => {
    expect(hasTerms).toBe(legalDocs.terms !== null)
    expect(hasPrivacy).toBe(legalDocs.privacy !== null)
  })
})
