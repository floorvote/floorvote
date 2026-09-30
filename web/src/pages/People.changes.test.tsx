import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async () => ({
    committees: [], people: [], updatedAt: null,
    councilmembers: [
      { name: 'Zachary Parker', role: 'Councilmember', termStart: '2023-01-02', termEnd: '2027-01-01', current: true },
      { name: 'Kenyan R. McDuffie', role: 'Councilmember', termStart: '2023-01-02', termEnd: '2026-01-05', current: false },
    ],
    changes: [
      { kind: 'chair_changed', committee: 'Committee on Youth Affairs', person: 'Ward 2 Councilmember Brooke Pinto', detail: 'Previously chaired by Ward 5 Councilmember Zachary Parker.', detectedAt: '2026-09-30 09:00:00' },
      { kind: 'member_left', committee: null, person: 'Kenyan R. McDuffie', detail: 'Term ended 2026-01-05.', detectedAt: '2026-01-06 09:00:00' },
    ],
  })),
}))
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))

import { People, describeChange } from './People'

describe('People: Council changes and members', () => {
  it('lists recent changes as sentences and separates former members', async () => {
    render(<People />)
    expect(await screen.findByText(/Ward 2 Councilmember Brooke Pinto now chairs the Committee on Youth Affairs\. Previously chaired by Ward 5 Councilmember Zachary Parker\./)).toBeInTheDocument()
    expect(screen.getByText(/Kenyan R\. McDuffie left the Council\. Term ended 2026-01-05\./)).toBeInTheDocument()
    expect(screen.getByText('Zachary Parker')).toBeInTheDocument()
    expect(screen.getByText(/Kenyan R\. McDuffie \(2023-01-02 to 2026-01-05\)/)).toBeInTheDocument()
  })

  it('describes staff and committee changes', () => {
    expect(describeChange({ kind: 'staff_added', committee: 'Committee on Health', person: 'A. Person', detail: 'Committee Director', detectedAt: '' })).toBe('A. Person, Committee Director, joined the Committee on Health staff.')
    expect(describeChange({ kind: 'committee_removed', committee: 'Committee on Recreation', person: null, detail: null, detectedAt: '' })).toBe('Committee on Recreation is no longer a Council committee.')
  })
})
