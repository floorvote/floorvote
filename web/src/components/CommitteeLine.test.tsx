import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CommitteeLine, type CommitteeRef, type ReferralRef } from './CommitteeLine'

interface Detail { history: { date: string; action: string }[]; lastAction: string | null; lastActionDate: string | null }

/** The bill's stored detail agrees with its last action, so the committee data can be trusted. */
const CURRENT: Detail = {
  history: [{ date: '2026-03-02', action: 'Referred to Judiciary' }],
  lastAction: 'Referred to Judiciary',
  lastActionDate: '2026-03-02',
}

/** The last action is newer than anything in the stored detail, as for a bill refreshed only from the master list. */
const STALE: Detail = { ...CURRENT, lastAction: 'Referred to Committee of the Whole', lastActionDate: '2026-09-01' }

function renderLine(committee: CommitteeRef | null, referrals: ReferralRef[], detail: Detail = CURRENT) {
  return render(
    <MemoryRouter initialEntries={['/bills/42']}>
      <CommitteeLine committee={committee} referrals={referrals} {...detail} />
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
        <CommitteeLine committee={{ committeeId: '7001', name: 'Judiciary', chamber: 'S' }} referrals={[JUDICIARY_SENATE]} {...CURRENT} linkToHistory={false} />
      </MemoryRouter>,
    )
    expect(screen.getByText('In committee:').parentElement).toHaveTextContent('In committee: Judiciary (Senate)')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('links to the Legislative History section of the bill page', () => {
    renderLine({ committeeId: '7001', name: 'Judiciary', chamber: 'S' }, [JUDICIARY_SENATE])
    expect(screen.getByRole('link', { name: /Judiciary/ })).toHaveAttribute('href', '/bills/42#section-actions')
  })

  describe('when the stored detail is older than the last action', () => {
    const PENDING = { committeeId: '7001', name: 'Judiciary', chamber: 'S' }

    it('renders nothing for a pending committee, which came from the same old detail', () => {
      const { container } = renderLine(PENDING, [JUDICIARY_SENATE], STALE)
      expect(container).toBeEmptyDOMElement()
      expect(screen.queryByText(/In committee/)).not.toBeInTheDocument()
    })

    it('renders nothing for referrals only', () => {
      const { container } = renderLine(null, [JUDICIARY_SENATE], STALE)
      expect(container).toBeEmptyDOMElement()
      expect(screen.queryByText(/Last referred to/)).not.toBeInTheDocument()
    })

    it('does not depend on what the last action says', () => {
      const { container } = renderLine(PENDING, [JUDICIARY_SENATE], { ...STALE, lastAction: 'Read third time' })
      expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing when a same-date last action differs in text from the history', () => {
      const { container } = renderLine(PENDING, [JUDICIARY_SENATE], { ...CURRENT, lastAction: 'Amended in committee' })
      expect(container).toBeEmptyDOMElement()
    })
  })

  describe('when the stored detail is current', () => {
    const PENDING = { committeeId: '7001', name: 'Judiciary', chamber: 'S' }

    it('says "In committee" with the chamber for a pending committee', () => {
      renderLine(PENDING, [JUDICIARY_SENATE], CURRENT)
      expect(screen.getByText('In committee:').parentElement).toHaveTextContent('In committee: Judiciary (Senate)')
    })

    it('says "Last referred to" for referrals only', () => {
      renderLine(null, [JUDICIARY_SENATE], CURRENT)
      expect(screen.getByText('Last referred to:').parentElement).toHaveTextContent('Last referred to: Judiciary (Senate), Mar 2026')
    })

    it('treats a bill with no last action as current', () => {
      renderLine(PENDING, [JUDICIARY_SENATE], { history: [], lastAction: null, lastActionDate: null })
      expect(screen.getByText('In committee:').parentElement).toHaveTextContent('In committee: Judiciary (Senate)')
    })

    it('treats a last action that matches the newest history entry as current', () => {
      renderLine(null, [JUDICIARY_SENATE], CURRENT)
      expect(screen.getByText('Last referred to:')).toBeInTheDocument()
    })

    it('treats a last action older than the newest history entry as current', () => {
      renderLine(PENDING, [JUDICIARY_SENATE], { ...CURRENT, lastAction: 'Introduced', lastActionDate: '2026-01-05' })
      expect(screen.getByText('In committee:')).toBeInTheDocument()
    })

    it('treats an empty history as current, as LegislativeHistory does', () => {
      renderLine(PENDING, [JUDICIARY_SENATE], { history: [], lastAction: 'Introduced', lastActionDate: '2026-01-05' })
      expect(screen.getByText('In committee:')).toBeInTheDocument()
    })
  })
})
