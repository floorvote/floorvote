import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LegislativeHistory } from './LegislativeHistory'

type LegislatorVote = { name: string; vote: string }

function renderVote(legislatorVotes: LegislatorVote[] | undefined) {
  render(<LegislativeHistory entries={[]} lastAction="Final Reading" lastActionDate="2026-07-07" votes={[{
    date: '2026-07-07', chamber: 'C', desc: 'Final Reading', yea: 11, nay: 2, nv: 0, absent: 0, passed: 1,
    legislatorVotes,
  }]} defaultOpen hideHeader />)
}

const voteLines = () => screen.getAllByText(/\(\d+\):/).map(el => el.parentElement!.textContent)

describe('legislator votes on the bill page', () => {
  it('lists each legislator under their vote, no votes first', () => {
    renderVote([{ name: 'Zachary Parker', vote: 'Yes' }, { name: 'Brooke Pinto', vote: 'No' }, { name: 'Robert White', vote: 'Yes' }])
    expect(screen.getByText('How each legislator voted')).toBeInTheDocument()
    expect(voteLines()).toEqual(['No (1): Brooke Pinto', 'Yes (2): Zachary Parker, Robert White'])
  })

  it("reads LegiScan's vote names the same way", () => {
    renderVote([
      { name: 'Ana Diaz', vote: 'Yea' }, { name: 'Ben Cole', vote: 'Nay' },
      { name: 'Cy Park', vote: 'NV' }, { name: 'Dee Lane', vote: 'Yea' }, { name: 'Eve Moss', vote: 'Absent' },
    ])
    expect(voteLines()).toEqual(['Nay (1): Ben Cole', 'Yea (2): Ana Diaz, Dee Lane', 'Absent (1): Eve Moss', 'NV (1): Cy Park'])
  })

  it('shows nothing extra for a roll call without legislator votes', () => {
    renderVote([])
    expect(screen.queryByText('How each legislator voted')).not.toBeInTheDocument()
  })
})
