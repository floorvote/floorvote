import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Bundled documents plus a demo tenant — the combination the gate exists for. Both
// mocks are required: without the first, the operator overlay is absent from the
// checkout and the links would be missing regardless of demoMode, so the test
// would pass without proving anything.
vi.mock('../lib/legalDocs', () => ({ hasTerms: true, hasPrivacy: true }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: true, demoLocked: true, settled: true }),
}))

const { OperatorBranding } = await import('./OperatorBranding')

const full = { name: 'Example Org', url: 'https://example.org/elections', contactEmails: ['ops@example.org'] }

describe('OperatorBranding — demo tenant', () => {
  it('hides both legal links', () => {
    render(<MemoryRouter><OperatorBranding operator={full} /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: 'Terms' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Privacy' })).toBeNull()
  })

  // The license and data-provider credits are not legal-doc links: AGPL §5 asks
  // that notices be preserved, and CC BY requires the attribution. A demo tenant
  // runs the same code under the same licenses, so these must survive.
  it('keeps the license and data attribution', () => {
    render(<MemoryRouter><OperatorBranding operator={full} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'AGPLv3' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'LegiScan' })).toBeInTheDocument()
  })

  // An explicit prop still wins, so the escape hatch the other suite relies on is
  // not quietly narrowed to non-demo tenants.
  it('still honours an explicit showTerms prop', () => {
    render(<MemoryRouter><OperatorBranding operator={full} showTerms /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Terms' })).toBeInTheDocument()
  })
})
