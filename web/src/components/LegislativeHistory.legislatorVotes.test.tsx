import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LegislativeHistory } from './LegislativeHistory'
import { color } from '../styles/tokens'

type LegislatorVote = { name: string; vote: string }
type Vote = {
  date: string; chamber: string | null; desc: string
  yea: number; nay: number; nv: number; absent: number; passed: number
  legislatorVotes?: LegislatorVote[]
}

function renderVotes(votes: Vote[]) {
  return render(<LegislativeHistory entries={[]} lastAction="Final Reading" lastActionDate="2026-07-07" votes={votes} defaultOpen hideHeader />)
}

const people = (vote: string, names: string[]): LegislatorVote[] => names.map((name) => ({ name, vote }))

// Fixtures per provider, with tallies that match their voter lists.
const legiscanVote: Vote = {
  date: '2026-07-07', chamber: 'H', desc: 'Passage', yea: 2, nay: 1, nv: 1, absent: 1, passed: 1,
  legislatorVotes: [
    { name: 'Ana Diaz', vote: 'Yea' }, { name: 'Ben Cole', vote: 'Nay' }, { name: 'Cy Park', vote: 'NV' },
    { name: 'Dee Lane', vote: 'Yea' }, { name: 'Eve Moss', vote: 'Absent' },
  ],
}
const dcVote: Vote = {
  date: '2026-07-07', chamber: 'C', desc: 'Final Reading', yea: 2, nay: 1, nv: 0, absent: 0, passed: 1,
  legislatorVotes: [
    { name: 'Zora Quill', vote: 'Yes' }, { name: 'Brin Hale', vote: 'No' }, { name: 'Rob Wick', vote: 'Yes' }, { name: 'Pat Moss', vote: 'Present' },
  ],
}
const lisVote: Vote = {
  date: '2026-07-07', chamber: 'S', desc: 'Passage', yea: 1, nay: 1, nv: 1, absent: 0, passed: 0,
  legislatorVotes: [
    { name: 'Ada Fox', vote: 'Yea' }, { name: 'Bo Gray', vote: 'Nay' }, { name: 'Cal Hunt', vote: 'Not Voting' }, { name: 'Dot Ives', vote: 'Abstain' },
  ],
}
const mgaVote: Vote = { date: '2026-07-07', chamber: 'S', desc: 'Third Reading', yea: 30, nay: 2, nv: 0, absent: 0, passed: 1, legislatorVotes: [] }

const toggle = () => screen.getByRole('button', { name: /^Yea/ })
const termFor = (w: string) => screen.getAllByRole('term').find((t) => t.textContent === w) as HTMLElement
const groupLabels = () => screen.getAllByRole('term').map((el) => el.textContent)

describe('the collapsed tally is the toggle', () => {
  it('is one button, "Yea 2 Nay 1", with only the nonzero optional counts', () => {
    renderVotes([{ ...legiscanVote, nv: 0, absent: 0, legislatorVotes: [...people('Yea', ['A', 'B']), ...people('Nay', ['C'])] }])
    const b = toggle()
    expect(b).toHaveAttribute('aria-expanded', 'false')
    expect(b).toHaveTextContent('Yea 2')
    expect(b).toHaveTextContent('Nay 1')
    expect(b).not.toHaveTextContent(/Not voting/)
    expect(b).not.toHaveTextContent(/Absent/)
  })
  it('adds Not voting and Absent when they are nonzero, in that order', () => {
    renderVotes([legiscanVote])
    expect(toggle()).toHaveTextContent(/Yea 2.*Nay 1.*Not voting 1.*Absent 1/)
  })
  it('adds Not voting alone, or Absent alone, when only one is nonzero', () => {
    const { unmount } = renderVotes([{ ...legiscanVote, absent: 0 }])
    expect(toggle()).toHaveTextContent(/Not voting 1/)
    expect(toggle()).not.toHaveTextContent(/Absent/)
    unmount()
    renderVotes([{ ...legiscanVote, nv: 0 }])
    expect(toggle()).toHaveTextContent(/Absent 1/)
    expect(toggle()).not.toHaveTextContent(/Not voting/)
  })
  it('never writes "NV" or "Yea:" in the tally', () => {
    renderVotes([legiscanVote])
    expect(toggle().textContent).not.toMatch(/NV|Yea:|Nay:/)
  })
  it('is a type=button with aria-controls, and a hidden disclosure triangle', () => {
    renderVotes([legiscanVote])
    const b = toggle()
    expect(b).toHaveAttribute('type', 'button')
    expect(b.getAttribute('aria-controls')).toBeTruthy()
    const tri = within(b).getByText('▶')
    expect(tri).toHaveAttribute('aria-hidden', 'true')
  })
  it('shows nothing of the voter list until expanded, and no old details control', () => {
    renderVotes([legiscanVote])
    expect(screen.queryByText('Ana Diaz')).not.toBeInTheDocument()
    expect(screen.queryByText('How each legislator voted')).not.toBeInTheDocument()
    expect(document.querySelector('details')).toBeNull()
    expect(screen.queryAllByRole('term')).toHaveLength(0)
  })
  it('turns the triangle when open', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    const tri = within(toggle()).getByText('▶')
    const closed = tri.style.transform
    await user.click(toggle())
    expect(within(toggle()).getByText('▶').style.transform).not.toBe(closed)
  })
})

describe('expanding the tally', () => {
  it('shows groups in Yea, Nay, Not voting, Absent order with names and no counts', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(groupLabels()).toEqual(['Yea', 'Nay', 'Not voting', 'Absent'])
    const defs = screen.getAllByRole('definition').map((el) => el.textContent)
    expect(defs).toEqual(['Ana Diaz, Dee Lane', 'Ben Cole', 'Cy Park', 'Eve Moss'])
    expect(termFor('Yea').parentElement!.textContent).not.toMatch(/\(\d+\)/)
  })
  it('puts the panel where aria-controls points', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    const id = toggle().getAttribute('aria-controls')!
    await user.click(toggle())
    const panel = document.getElementById(id)
    expect(panel).not.toBeNull()
    expect(within(panel!).getByText('Ana Diaz')).toBeInTheDocument()
  })
  it('lays groups out as a label column beside a names column', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    await user.click(toggle())
    const list = screen.getAllByRole('term')[0].parentElement!
    expect(list.tagName).toBe('DL')
    expect(list.style.display).toBe('grid')
    expect(list.style.gridTemplateColumns.split(/\s+/)).toHaveLength(2)
  })
  it('collapses again on a second click and removes the list', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    await user.click(toggle())
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Ana Diaz')).not.toBeInTheDocument()
  })
  it('wraps each voter name in its own element, so a name can later become a link', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    await user.click(toggle())
    const names = screen.getAllByTestId('voter-name').map((el) => el.textContent)
    expect(names).toEqual(['Ana Diaz', 'Dee Lane', 'Ben Cole', 'Cy Park', 'Eve Moss'])
  })
})

describe('one vocabulary for every provider', () => {
  it('reads a DC roll call with Yes/No/Present as Yea/Nay/Present', async () => {
    const user = userEvent.setup()
    renderVotes([dcVote])
    await user.click(toggle())
    expect(groupLabels()).toEqual(['Yea', 'Nay', 'Present'])
    expect(screen.queryByText('Yes')).not.toBeInTheDocument()
    expect(screen.queryByText('No')).not.toBeInTheDocument()
    expect(screen.getAllByRole('definition').map((el) => el.textContent)).toEqual(['Zora Quill, Rob Wick', 'Brin Hale', 'Pat Moss'])
  })
  it('reads a lis roll call: Not Voting becomes Not voting, Abstain stays its own group after the four', async () => {
    const user = userEvent.setup()
    renderVotes([lisVote])
    await user.click(toggle())
    expect(groupLabels()).toEqual(['Yea', 'Nay', 'Not voting', 'Abstain'])
  })
  it('reads lims Recused after Absent and Present, with the main four first', async () => {
    const user = userEvent.setup()
    renderVotes([{ ...dcVote, yea: 1, nay: 1, nv: 0, absent: 1, legislatorVotes: [
      { name: 'A', vote: 'Recused' }, { name: 'B', vote: 'Absent' }, { name: 'C', vote: 'Present' }, { name: 'D', vote: 'No' }, { name: 'E', vote: 'Yes' },
    ] }])
    await user.click(toggle())
    expect(groupLabels()).toEqual(['Yea', 'Nay', 'Absent', 'Present', 'Recused'])
  })
  it('shows an unknown vote word as its own group, as given', async () => {
    const user = userEvent.setup()
    renderVotes([{ ...legiscanVote, legislatorVotes: [...(legiscanVote.legislatorVotes ?? []), { name: 'Fox Ward', vote: 'Conflicted' }] }])
    await user.click(toggle())
    expect(groupLabels()).toEqual(['Yea', 'Nay', 'Not voting', 'Absent', 'Conflicted'])
    expect(screen.getByText('Fox Ward')).toBeInTheDocument()
  })
  it('keeps every voter on the page: the groups hold exactly the voters given', async () => {
    const user = userEvent.setup()
    renderVotes([{ ...lisVote, legislatorVotes: [...(lisVote.legislatorVotes ?? []), { name: 'Eli Jay', vote: '???' }] }])
    await user.click(toggle())
    expect(screen.getAllByTestId('voter-name')).toHaveLength(5)
  })
})

describe('totals match the voter list', () => {
  it.each([['LegiScan', legiscanVote], ['DC', dcVote], ['lis', lisVote]] as const)('%s tally counts equal the group sizes', async (_n, vote) => {
    const user = userEvent.setup()
    renderVotes([vote])
    const tallyText = toggle().textContent!
    await user.click(toggle())
    const sizes = new Map(screen.getAllByRole('term').map((t) => [t.textContent!, (t.nextElementSibling as HTMLElement).querySelectorAll('[data-testid="voter-name"]').length]))
    expect(tallyText).toContain(`Yea ${sizes.get('Yea') ?? 0}`)
    expect(tallyText).toContain(`Nay ${sizes.get('Nay') ?? 0}`)
    expect(vote.yea + vote.nay + vote.nv + vote.absent).toBeLessThanOrEqual(vote.legislatorVotes!.length)
    if (vote.nv) expect(tallyText).toContain(`Not voting ${sizes.get('Not voting')}`)
    if (vote.absent) expect(tallyText).toContain(`Absent ${sizes.get('Absent')}`)
  })
  it('keeps the provider totals in the tally even when the voter list differs', () => {
    renderVotes([{ ...legiscanVote, yea: 9, legislatorVotes: people('Yea', ['A']) }])
    expect(toggle()).toHaveTextContent('Yea 9')
  })
})

describe('a roll call with no individual votes', () => {
  it('shows the tally as plain text, not a button that opens nothing', () => {
    renderVotes([mgaVote])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText(/Yea 30/)).toBeInTheDocument()
    expect(screen.getByText(/Nay 2/)).toBeInTheDocument()
    expect(document.querySelector('[aria-expanded]')).toBeNull()
  })
  it('treats a missing voter list the same way', () => {
    renderVotes([{ ...mgaVote, legislatorVotes: undefined }])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText(/Yea 30/)).toBeInTheDocument()
  })
  it('still hides zero optional counts and uses the same order', () => {
    renderVotes([{ ...mgaVote, nv: 4, absent: 3 }])
    expect(screen.getByText(/Yea 30/).closest('div')!.textContent).toMatch(/Yea 30.*Nay 2.*Not voting 4.*Absent 3/)
  })
})

describe('committee votes and floor votes', () => {
  const committee: Vote = { ...legiscanVote, chamber: 'S', desc: 'Committee on Rules: Do Pass', yea: 1, nay: 0, nv: 0, absent: 0, legislatorVotes: people('Yea', ['Committee Chair']) }
  const floor: Vote = { ...legiscanVote, date: '2026-07-08', chamber: 'S', desc: 'Senate Final Passage' }
  it('gives each roll call its own toggle that opens on its own', async () => {
    const user = userEvent.setup()
    renderVotes([floor, committee])
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].getAttribute('aria-controls')).not.toBe(buttons[1].getAttribute('aria-controls'))
    await user.click(buttons[1])
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Committee Chair')).toBeInTheDocument()
    expect(screen.queryByText('Ana Diaz')).not.toBeInTheDocument()
  })
  it('keeps the description above the tally for both', () => {
    renderVotes([floor, committee])
    expect(screen.getByText('Committee on Rules: Do Pass')).toBeInTheDocument()
    expect(screen.getByText('Senate Final Passage')).toBeInTheDocument()
  })
})

describe('colors follow the vote, in the tally and the list', () => {
  it('colors Yea green, Nay red, and the rest gray in both places', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    const inTally = (word: string) => within(toggle()).getByText(new RegExp(`^${word}`)) as HTMLElement
    expect(inTally('Yea').style.color).toBe(color.textSuccessDark)
    expect(inTally('Nay').style.color).toBe(color.textDanger)
    expect(inTally('Not voting').style.color).toBe(color.textSecondary)
    expect(inTally('Absent').style.color).toBe(color.textSecondary)
    await user.click(toggle())
    const term = termFor
    expect(term('Yea').style.color).toBe(color.textSuccessDark)
    expect(term('Nay').style.color).toBe(color.textDanger)
    expect(term('Not voting').style.color).toBe(color.textSecondary)
    expect(term('Absent').style.color).toBe(color.textSecondary)
  })
  it('uses only theme tokens, never a raw hex, so dark mode follows', async () => {
    const user = userEvent.setup()
    const { container } = renderVotes([dcVote])
    await user.click(toggle())
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
  it('colors an unknown word gray', async () => {
    const user = userEvent.setup()
    renderVotes([{ ...legiscanVote, legislatorVotes: [{ name: 'X', vote: 'Yea' }, { name: 'Y', vote: 'Conflicted' }] }])
    await user.click(toggle())
    expect(termFor('Conflicted').style.color).toBe(color.textSecondary)
  })
})

describe('keyboard and screen reader', () => {
  it('reaches the tally with Tab and opens and closes it with Enter and Space', async () => {
    const user = userEvent.setup()
    renderVotes([legiscanVote])
    await user.tab()
    expect(toggle()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).toHaveFocus()
  })
  it('names the button by its tally, in words, without the triangle or the dots', () => {
    renderVotes([legiscanVote])
    expect(screen.getByRole('button', { name: 'Yea 2 Nay 1 Not voting 1 Absent 1' })).toBeInTheDocument()
  })
  it('reads the list as terms and definitions, one pair per group', async () => {
    const user = userEvent.setup()
    renderVotes([dcVote])
    await user.click(toggle())
    expect(screen.getAllByRole('term')).toHaveLength(3)
    expect(screen.getAllByRole('definition')).toHaveLength(3)
  })
  it('does not leave the closed panel in the accessibility tree', () => {
    renderVotes([legiscanVote])
    const id = toggle().getAttribute('aria-controls')!
    expect(document.getElementById(id)).toBeNull()
  })
})

describe('long voter lists', () => {
  const names = Array.from({ length: 140 }, (_, i) => `Voter Number${i + 1}`)
  it('lists every name once expanded, grouped, without a count', async () => {
    const user = userEvent.setup()
    renderVotes([{ ...legiscanVote, yea: 100, nay: 40, nv: 0, absent: 0, legislatorVotes: [...people('Yea', names.slice(0, 100)), ...people('Nay', names.slice(100))] }])
    expect(toggle()).toHaveTextContent('Yea 100')
    await user.click(toggle())
    expect(screen.getAllByTestId('voter-name')).toHaveLength(140)
    expect(screen.getByText('Voter Number140')).toBeInTheDocument()
    expect(termFor('Nay').nextElementSibling!.querySelectorAll('[data-testid="voter-name"]')).toHaveLength(40)
  })
  it('lets long names wrap instead of overflowing', async () => {
    const user = userEvent.setup()
    renderVotes([{ ...legiscanVote, legislatorVotes: people('Yea', ['Alexandria Bartholomew-Montgomery-Fitzgerald-Worthington III']) }])
    await user.click(toggle())
    const dd = screen.getByRole('definition') as HTMLElement
    expect(dd.style.overflowWrap).toBe('anywhere')
    expect(dd.style.minWidth).toBe('0px')
  })
})
