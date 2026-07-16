import { describe, it, expect } from 'vitest'
import { resolveLegalDocs } from './legalDocs'

describe('resolveLegalDocs', () => {
  it('maps terms and privacy from real (spaced, uppercase) filenames', () => {
    const raw = {
      '/repo/docs/legal/TERMS OF USE.md': '# Terms',
      '/repo/docs/legal/PRIVACY POLICY.md': '# Privacy',
    }
    expect(resolveLegalDocs(raw)).toEqual({ terms: '# Terms', privacy: '# Privacy' })
  })

  it('returns null for a doc that is absent', () => {
    const raw = { '/repo/docs/legal/TERMS OF USE.md': '# Terms' }
    expect(resolveLegalDocs(raw)).toEqual({ terms: '# Terms', privacy: null })
  })

  it('returns both null when nothing matches', () => {
    expect(resolveLegalDocs({})).toEqual({ terms: null, privacy: null })
  })
})
