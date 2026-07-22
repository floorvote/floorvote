import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VoteButton } from './VoteButton'

// The button's action hint ("Vote support on this bill" / "You voted support —
// click to remove your vote") previously lived only in a mouse-only tooltip
// bubble. It must be reachable without hovering — via the button's own
// accessible name — since the visible label ("Support"/"Neutral"/"Oppose")
// alone doesn't convey the action or the current vote state.
describe('VoteButton accessible name', () => {
  it('exposes the unvoted hint as its accessible name', () => {
    render(<VoteButton label="Support" pos="support" current={null} onClick={() => {}} />)
    expect(screen.getByRole('button', { name: /vote support on this bill/i })).toBeTruthy()
  })

  it('exposes the voted hint as its accessible name', () => {
    render(<VoteButton label="Support" pos="support" current="support" onClick={() => {}} />)
    expect(screen.getByRole('button', { name: /you voted support — click to remove your vote/i })).toBeTruthy()
  })

  it('still shows the short visible label', () => {
    render(<VoteButton label="Oppose" pos="oppose" current={null} onClick={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /vote oppose on this bill/i })
    expect(btn.textContent).toBe('Oppose')
  })
})
