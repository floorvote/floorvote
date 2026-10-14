import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CommitteeLine, type CommitteeRef, type ReferralRef } from './CommitteeLine'

function renderLine(committee: CommitteeRef | null, referrals: ReferralRef[]) {
  return render(
    <MemoryRouter initialEntries={['/bills/42']}>
      <CommitteeLine committee={committee} referrals={referrals} />
    </MemoryRouter>,
  )
}

const JUDICIARY_SENATE: ReferralRef = { date: '2026-03-02', committeeId: '7001', name: 'Judiciary', chamber: 'S' }

describe('CommitteeLine', () => {
  it('says "In committee" with the chamber when the bill has a pending committee', () => {
    renderLine({ committeeId: '7001', name: 'Judiciary', chamber: 'S' }, [JUDICIARY_SENATE])
    expect(screen.getByText('In committee:').parentElement).toHaveTextContent('In committee: Judiciary (Senate)')
    expect(screen.queryByText(/Last referred to/)).not.toBeInTheDocument()
  })

  it('tells same-named committees apart by chamber', () => {
    renderLine({ committeeId: '7002', name: 'Judiciary', chamber: 'H' }, [])
    expect(screen.getByText('In committee:').parentElement).toHaveTextContent('In committee: Judiciary (House)')
  })

  it('says "Last referred to" with chamber and month for a bill with referrals and no pending committee', () => {
    renderLine(null, [JUDICIARY_SENATE])
    expect(screen.getByText('Last referred to:').parentElement).toHaveTextContent('Last referred to: Judiciary (Senate), Mar 2026')
    expect(screen.queryByText(/In committee/)).not.toBeInTheDocument()
  })

  it('names the latest referral when the bill was referred more than once', () => {
    renderLine(null, [
      { date: '2026-01-16', committeeId: '7003', name: 'Rules', chamber: 'H' },
      { date: '2026-03-02', committeeId: '7001', name: 'Judiciary', chamber: 'S' },
    ])
    const line = screen.getByText('Last referred to:').parentElement
    expect(line).toHaveTextContent('Last referred to: Judiciary (Senate), Mar 2026')
    expect(line).not.toHaveTextContent('Rules')
  })

  it('leaves out the month when the latest referral has no date', () => {
    renderLine(null, [{ date: null, committeeId: null, name: 'Retained by the Council', chamber: 'C' }])
    expect(screen.getByText('Last referred to:').parentElement).toHaveTextContent(/^Last referred to: Retained by the Council \(Council\)$/)
  })

  it('shows a subcommittee as the data names it, with its chamber', () => {
    renderLine(null, [{ date: '2026-02-10', committeeId: '8001', name: 'House Judiciary Subcommittee on the Constitution', chamber: 'H' }])
    expect(screen.getByText('Last referred to:').parentElement)
      .toHaveTextContent('Last referred to: House Judiciary Subcommittee on the Constitution (House), Feb 2026')
  })

  it('drops the chamber parenthetical when the data has no chamber', () => {
    renderLine({ committeeId: null, name: 'Stored committee', chamber: null }, [])
    expect(screen.getByText('In committee:').parentElement).toHaveTextContent(/^In committee: Stored committee$/)
  })

  it('renders nothing when the bill has no committee and no referrals', () => {
    const { container } = renderLine(null, [])
    expect(container).toBeEmptyDOMElement()
  })

  it('is plain text, with no link, when told the page has no Legislative History section', () => {
    render(
      <MemoryRouter initialEntries={['/bills/42']}>
        <CommitteeLine committee={{ committeeId: '7001', name: 'Judiciary', chamber: 'S' }} referrals={[JUDICIARY_SENATE]} linkToHistory={false} />
      </MemoryRouter>,
    )
    expect(screen.getByText('In committee:').parentElement).toHaveTextContent('In committee: Judiciary (Senate)')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('links to the Legislative History section of the bill page', () => {
    renderLine({ committeeId: '7001', name: 'Judiciary', chamber: 'S' }, [JUDICIARY_SENATE])
    expect(screen.getByRole('link', { name: /Judiciary/ })).toHaveAttribute('href', '/bills/42#section-actions')
  })
})
