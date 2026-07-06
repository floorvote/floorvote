import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { chamberLabel, chamberStyle, LegislativeHistory, syntheticLatestAction } from './LegislativeHistory'

describe('chamberLabel', () => {
  it('maps S to Senate', () => expect(chamberLabel('S')).toBe('Senate'))
  it('maps upper to Senate', () => expect(chamberLabel('upper')).toBe('Senate'))
  it('maps H to House', () => expect(chamberLabel('H')).toBe('House'))
  it('maps lower to House', () => expect(chamberLabel('lower')).toBe('House'))
  it('maps A to Assembly', () => expect(chamberLabel('A')).toBe('Assembly'))
  it('returns empty string for undefined', () => expect(chamberLabel(undefined)).toBe(''))
  it('returns value as-is for unknown code', () => expect(chamberLabel('X')).toBe('X'))
})

describe('chamberStyle', () => {
  it('returns teal colors for Senate (S)', () => {
    const s = chamberStyle('S')
    expect(s.color).toBe('#0f766e')
    expect(s.background).toBe('#f0fdfa')
  })
  it('returns teal colors for Senate (upper)', () => {
    const s = chamberStyle('upper')
    expect(s.color).toBe('#0f766e')
    expect(s.background).toBe('#f0fdfa')
  })
  it('returns amber colors for House (H)', () => {
    const s = chamberStyle('H')
    expect(s.color).toBe('#92400e')
    expect(s.background).toBe('#fef3c7')
  })
  it('returns amber colors for Assembly (A)', () => {
    const s = chamberStyle('A')
    expect(s.color).toBe('#92400e')
    expect(s.background).toBe('#fef3c7')
  })
  it('returns amber colors for lower chamber code (lower)', () => {
    const s = chamberStyle('lower')
    expect(s.color).toBe('#92400e')
    expect(s.background).toBe('#fef3c7')
  })
  it('returns amber colors for unknown code (documents fallback)', () => {
    const s = chamberStyle('X')
    expect(s.color).toBe('#92400e')
    expect(s.background).toBe('#fef3c7')
  })
})

const baseProps = {
  lastAction: 'Signed by Governor',
  lastActionDate: '2026-04-20',
  defaultOpen: true,
}

const passedVote = {
  date: '2026-04-16',
  chamber: 'S',
  desc: 'Passage In Concurrence',
  yea: 30, nay: 1, nv: 7, absent: 0, passed: 1,
}

const failedVote = {
  date: '2026-03-12',
  chamber: 'H',
  desc: 'Passage',
  yea: 14, nay: 21, nv: 3, absent: 0, passed: 0,
}

describe('LegislativeHistory vote rows', () => {
  it('shows VOTE: PASSED chip for a passed roll call', () => {
    render(<LegislativeHistory {...baseProps} entries={[]} votes={[passedVote]} />)
    expect(screen.getByText('VOTE: PASSED')).toBeInTheDocument()
  })

  it('shows VOTE: FAILED chip for a failed roll call', () => {
    render(<LegislativeHistory {...baseProps} entries={[]} votes={[failedVote]} />)
    expect(screen.getByText('VOTE: FAILED')).toBeInTheDocument()
  })

  it('shows the chamber chip for a vote row', () => {
    render(<LegislativeHistory {...baseProps} entries={[]} votes={[passedVote]} />)
    expect(screen.getByText('Senate')).toBeInTheDocument()
  })

  it('does not show the old "· Senate" suffix in vote description', () => {
    render(<LegislativeHistory {...baseProps} entries={[]} votes={[passedVote]} />)
    expect(screen.queryByText(/· Senate/)).not.toBeInTheDocument()
  })

  it('does not show old VOTE badge without outcome', () => {
    render(<LegislativeHistory {...baseProps} entries={[]} votes={[passedVote]} />)
    const voteTexts = screen.queryAllByText('VOTE')
    expect(voteTexts).toHaveLength(0)
  })

  it('shows vote counts', () => {
    render(<LegislativeHistory {...baseProps} entries={[]} votes={[passedVote]} />)
    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })
})

const staleEntries = [
  { date: '2026-05-14', action: 'House read and passed', chamber: 'H' },
  { date: '2026-05-15', action: 'Referred to Senate Special Legislation and Veterans Affairs', chamber: 'S' },
]

describe('syntheticLatestAction', () => {
  it('returns null when lastAction or lastActionDate is missing', () => {
    expect(syntheticLatestAction(staleEntries, null, '2026-06-11')).toBeNull()
    expect(syntheticLatestAction(staleEntries, 'Signed by Governor', null)).toBeNull()
  })

  it('returns null when the last action is already in the history', () => {
    expect(syntheticLatestAction(
      staleEntries,
      'Referred to Senate Special Legislation and Veterans Affairs',
      '2026-05-15',
    )).toBeNull()
  })

  it('matches entries even when one side has an embedded MM/DD/YYYY date prefix', () => {
    expect(syntheticLatestAction(
      staleEntries,
      '05/15/2026 Referred to Senate Special Legislation and Veterans Affairs',
      '2026-05-15',
    )).toBeNull()
  })

  it('returns a synthetic entry when the last action is newer than all history', () => {
    expect(syntheticLatestAction(staleEntries, "Effective without Governor's signature", '2026-06-11'))
      .toEqual({ date: '2026-06-11', action: "Effective without Governor's signature" })
  })

  it('returns a synthetic entry on a same-date action not present in history', () => {
    expect(syntheticLatestAction(staleEntries, 'Senate read and passed', '2026-05-15'))
      .toEqual({ date: '2026-05-15', action: 'Senate read and passed' })
  })

  it('returns null when the last action is older than the newest history entry', () => {
    expect(syntheticLatestAction(staleEntries, 'House read and passed', '2026-05-13')).toBeNull()
  })

  it('returns a synthetic entry when history is empty', () => {
    expect(syntheticLatestAction([], 'Introduced', '2026-04-17'))
      .toEqual({ date: '2026-04-17', action: 'Introduced' })
  })
})

describe('LegislativeHistory stale-history gap row', () => {
  it('prepends the last action and shows a gap notice when history is stale', () => {
    render(
      <LegislativeHistory
        entries={staleEntries}
        votes={[]}
        lastAction="Effective without Governor's signature"
        lastActionDate="2026-06-11"
        defaultOpen
        hideHeader
      />,
    )
    expect(screen.queryByText("Effective without Governor's signature")).not.toBeNull()
    expect(screen.queryByText(/may not be shown/)).not.toBeNull()
  })

  it('shows no gap notice when the last action is already in the history', () => {
    render(
      <LegislativeHistory
        entries={staleEntries}
        votes={[]}
        lastAction="Referred to Senate Special Legislation and Veterans Affairs"
        lastActionDate="2026-05-15"
        defaultOpen
        hideHeader
      />,
    )
    expect(screen.queryByText(/may not be shown/)).toBeNull()
  })

  it('shows no gap notice when history is empty (nothing to gap against)', () => {
    render(
      <LegislativeHistory
        entries={[]}
        votes={[]}
        lastAction="Introduced"
        lastActionDate="2026-04-17"
        defaultOpen
        hideHeader
      />,
    )
    expect(screen.queryByText('Introduced')).not.toBeNull()
    expect(screen.queryByText(/may not be shown/)).toBeNull()
  })

  it('counts the synthetic row in the collapsed header event count', () => {
    render(
      <LegislativeHistory
        entries={staleEntries}
        votes={[]}
        lastAction="Effective without Governor's signature"
        lastActionDate="2026-06-11"
      />,
    )
    expect(screen.queryByText(/3 events/)).not.toBeNull()
  })
})
