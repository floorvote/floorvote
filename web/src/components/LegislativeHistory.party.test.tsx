import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LegislativeHistory } from './LegislativeHistory'
import { color } from '../styles/tokens'

type LegislatorVote = { name: string; vote: string; url?: string | null; party?: string | null }

async function renderExpanded(legislatorVotes: LegislatorVote[]) {
  const vote = { date: '2026-07-07', chamber: 'H', desc: 'Passage', yea: legislatorVotes.length, nay: 0, nv: 0, absent: 0, passed: 1, legislatorVotes }
  render(<LegislativeHistory entries={[]} lastAction="Final Reading" lastActionDate="2026-07-07" votes={[vote]} defaultOpen hideHeader />)
  await userEvent.click(screen.getByRole('button', { name: /^Yea/ }))
}

const textOf = (n: string) => (voter(n).textContent ?? '').replace(/^, /, '')
const voter = (name: string) => screen.getAllByTestId('voter-name').find((el) => el.textContent?.startsWith(name))?.parentElement as HTMLElement

describe('party chips in the roll call', () => {
  it('shows a mini chip after each voter with a party, colored like the sponsor chip', async () => {
    await renderExpanded([
      { name: 'Ana Diaz', vote: 'Yea', party: 'D' },
      { name: 'Ben Cole', vote: 'Yea', party: 'R' },
      { name: 'Cy Park', vote: 'Yea', party: 'I' },
    ])
    const d = within(voter('Ana Diaz')).getByText('D')
    const r = within(voter('Ben Cole')).getByText('R')
    const i = within(voter('Cy Park')).getByText('I')
    expect(d.style.color).toBe(color.linkBlue)
    expect(d.style.background).toBe(color.bgBlueChip)
    expect(r.style.color).toBe(color.textDanger)
    expect(r.style.background).toBe(color.bgRedPriority)
    expect(i.style.color).toBe(color.textSlate500)
    expect(i.style.background).toBe(color.surfaceMuted)
  })

  it('uses the mini size', async () => {
    await renderExpanded([{ name: 'Ana Diaz', vote: 'Yea', party: 'D' }])
    expect(parseFloat(within(voter('Ana Diaz')).getByText('D').style.fontSize)).toBeLessThan(10)
  })

  it('puts the chip after the name, and after the profile link icon when there is one', async () => {
    await renderExpanded([
      { name: 'Ana Diaz', vote: 'Yea', party: 'D', url: 'https://legislature.example/members/diaz' },
      { name: 'Ben Cole', vote: 'Yea', party: 'R' },
    ])
    const ana = voter('Ana Diaz')
    const link = within(ana).getByRole('link', { name: 'Ana Diaz' })
    const chipA = within(ana).getByText('D')
    expect(link.contains(chipA)).toBe(false)
    expect(link.compareDocumentPosition(chipA) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(textOf('Ben Cole')).toBe('Ben ColeR')
  })

  it('shows no chip and no gap for a voter with no party', async () => {
    await renderExpanded([
      { name: 'Ana Diaz', vote: 'Yea', party: null },
      { name: 'Ben Cole', vote: 'Yea' },
      { name: 'Cy Park', vote: 'Yea', party: '' },
      { name: 'Dee Lane', vote: 'Yea', party: '   ' },
    ])
    for (const n of ['Ana Diaz', 'Ben Cole', 'Cy Park', 'Dee Lane']) {
      expect(textOf(n)).toBe(n)
      expect(voter(n).querySelectorAll(':scope > span')).toHaveLength(1)
    }
    expect(screen.getByRole('definition').textContent).toBe('Ana Diaz, Ben Cole, Cy Park, Dee Lane')
  })

  it('shows an unknown party code with neutral colors', async () => {
    await renderExpanded([{ name: 'Ana Diaz', vote: 'Yea', party: 'Green' }, { name: 'Ben Cole', vote: 'Yea', party: 'NP' }])
    const green = within(voter('Ana Diaz')).getByText('Green')
    expect(green.style.color).toBe(color.textSlate500)
    expect(green.style.background).toBe(color.surfaceMuted)
    expect(within(voter('Ben Cole')).getByText('NP')).toBeInTheDocument()
  })

  it('names the party in text a screen reader reads, not by color alone', async () => {
    await renderExpanded([{ name: 'Ana Diaz', vote: 'Yea', party: 'D' }])
    const chip = within(voter('Ana Diaz')).getByText('D')
    expect(chip.closest('[aria-hidden="true"]')).toBeNull()
    expect(textOf('Ana Diaz')).toBe('Ana DiazD')
  })

  it('renders exactly as before when a central from before party sends none', async () => {
    await renderExpanded([
      { name: 'Ana Diaz', vote: 'Yea', url: 'https://legislature.example/members/diaz' },
      { name: 'Ben Cole', vote: 'Yea' },
    ])
    expect(textOf('Ana Diaz')).toBe('Ana Diaz')
    expect(textOf('Ben Cole')).toBe('Ben Cole')
    expect(screen.getByRole('definition').textContent).toBe('Ana Diaz, Ben Cole')
  })
})
