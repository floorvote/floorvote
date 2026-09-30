import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LegislativeHistory } from './LegislativeHistory'

describe('member votes on the bill page', () => {
  it('lists each member under their vote, no votes first', () => {
    render(<LegislativeHistory entries={[]} lastAction="Final Reading" lastActionDate="2026-07-07" votes={[{
      date: '2026-07-07', chamber: 'C', desc: 'Final Reading', yea: 11, nay: 2, nv: 0, absent: 0, passed: 1,
      memberVotes: [{ name: 'Zachary Parker', vote: 'Yes' }, { name: 'Brooke Pinto', vote: 'No' }, { name: 'Robert White', vote: 'Yes' }],
    }]} defaultOpen hideHeader />)
    expect(screen.getByText('How each member voted')).toBeInTheDocument()
    const lines = screen.getAllByText(/\(\d\):/).map(el => el.parentElement!.textContent)
    expect(lines).toEqual(['No (1): Brooke Pinto', 'Yes (2): Zachary Parker, Robert White'])
  })
})
