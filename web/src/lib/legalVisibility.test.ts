import { describe, it, expect, vi } from 'vitest'

// Both present, so the demo condition is the only thing under test. Without this
// the real-named documents are absent from the checkout (operator overlay,
// gitignored upstream), hasTerms/hasPrivacy are false, and every assertion below
// would pass for the wrong reason.
vi.mock('./legalDocs', () => ({ hasTerms: true, hasPrivacy: true }))

const { legalDocsVisible } = await import('./legalVisibility')

describe('legalDocsVisible', () => {
  it('surfaces both documents on a normal tenant', () => {
    expect(legalDocsVisible(false)).toEqual({ showTerms: true, showPrivacy: true })
  })

  // Both, not just the Terms: the Privacy Policy carries the same account-scoped
  // definition of the Services, so neither governs a demo visitor.
  it('surfaces neither on a demo tenant', () => {
    expect(legalDocsVisible(true)).toEqual({ showTerms: false, showPrivacy: false })
  })
})

describe('legalDocsVisible — documents absent', () => {
  it('stays false on a normal tenant when nothing was bundled', async () => {
    vi.resetModules()
    vi.doMock('./legalDocs', () => ({ hasTerms: false, hasPrivacy: false }))
    const { legalDocsVisible: fresh } = await import('./legalVisibility')
    expect(fresh(false)).toEqual({ showTerms: false, showPrivacy: false })
  })
})
