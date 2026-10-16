import { describe, it, expect } from 'vitest'
import { renderDigestEmail } from '../../src/lib/digestEmail'

// #366: a member's digest carries the same section, but a member can't set a
// priority or dismiss, so the line that tells admins to is left off.
describe("renderDigestEmail: the new-match section in a member's digest", () => {
  const items = [{ billId: 'm1', billNumber: 'HB 1001', billTitle: 'Matched bill 1', billState: 'RI', billSession: '2026', relevanceScore: 5 }]

  it("doesn't tell a member to set a priority or dismiss", () => {
    const html = renderDigestEmail({ events: [], assocName: 'X', appUrl: 'https://x', newMatches: items, forMember: true })
    expect(html).toContain('New matches (1)')
    expect(html).toContain('HB 1001')
    expect(html).not.toContain('Set a priority or dismiss')
  })

  it('keeps the admin wording for an admin', () => {
    const html = renderDigestEmail({ events: [], assocName: 'X', appUrl: 'https://x', newMatches: items })
    expect(html).toContain('Set a priority or dismiss each from the bill list.')
  })
})
