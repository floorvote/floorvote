import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SentimentBars } from './SentimentBars'

// A voter with no name (never set, or cleared under #233) shows by email in the
// admin's individual-votes breakdown. The API sends a blank userName plus
// userEmail for them.

describe('SentimentBars individual votes, voter with no name', () => {
  it('lists the voter by email', async () => {
    render(
      <SentimentBars
        isAdmin
        voteCounts={{ support: 1, oppose: 1, neutral: 0, total: 2 }}
        memberVotes={[
          { userName: 'Named Voter', userEmail: 'named@example.com', position: 'support', votedAt: '2026-01-01 00:00:00' },
          { userName: '', userEmail: 'cleared@example.com', position: 'oppose', votedAt: '2026-01-01 00:00:00' },
        ]}
      />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /individual votes/i }))
    expect(screen.getByText('cleared@example.com')).toBeInTheDocument()
    expect(screen.getByText('Named Voter')).toBeInTheDocument()
    expect(screen.queryByText('named@example.com')).not.toBeInTheDocument()
  })
})
