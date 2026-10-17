import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LegislativeHistory } from './LegislativeHistory'

type LegislatorVote = { name: string; vote: string; url?: string | null }
type Vote = {
  date: string; chamber: string | null; desc: string
  yea: number; nay: number; nv: number; absent: number; passed: number
  legislatorVotes?: LegislatorVote[]
}

async function renderExpanded(legislatorVotes: LegislatorVote[]) {
  const vote: Vote = { date: '2026-07-07', chamber: 'H', desc: 'Passage', yea: 3, nay: 1, nv: 0, absent: 0, passed: 1, legislatorVotes }
  render(<LegislativeHistory entries={[]} lastAction="Final Reading" lastActionDate="2026-07-07" votes={[vote]} defaultOpen hideHeader />)
  await userEvent.click(screen.getByRole('button', { name: /^Yea/ }))
}

const voter = (name: string) => screen.getAllByTestId('voter-name').find((el) => el.textContent === name) as HTMLElement

describe('a voter with a profile url', () => {
  it('is a link to it that opens in a new tab without leaking the page', async () => {
    await renderExpanded([{ name: 'Ana Diaz', vote: 'Yea', url: 'https://legislature.example/members/diaz' }])
    const link = screen.getByRole('link', { name: 'Ana Diaz' })
    expect(link).toHaveAttribute('href', 'https://legislature.example/members/diaz')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('uses the sponsors link style', async () => {
    await renderExpanded([{ name: 'Ana Diaz', vote: 'Yea', url: 'https://legislature.example/members/diaz' }])
    expect(screen.getByRole('link', { name: 'Ana Diaz' })).toHaveClass('blue-link')
  })

  it('keeps the name as the voter element, so the list and its order are unchanged', async () => {
    await renderExpanded([
      { name: 'Ana Diaz', vote: 'Yea', url: 'https://legislature.example/members/diaz' },
      { name: 'Ben Cole', vote: 'Yea', url: null },
      { name: 'Cy Park', vote: 'Nay' },
    ])
    expect(screen.getAllByTestId('voter-name').map((el) => el.textContent)).toEqual(['Ana Diaz', 'Ben Cole', 'Cy Park'])
    expect(within(voter('Ana Diaz')).getByRole('link', { name: 'Ana Diaz' })).toBeInTheDocument()
  })
})

describe('a voter without a profile url', () => {
  it('is plain text, whether the url is null, missing, or blank', async () => {
    await renderExpanded([
      { name: 'Ben Cole', vote: 'Yea', url: null },
      { name: 'Cy Park', vote: 'Yea' },
      { name: 'Dee Lane', vote: 'Yea', url: '  ' },
    ])
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.getAllByTestId('voter-name')).toHaveLength(3)
  })
})

describe('a voter whose url is not http or https', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['a relative path', '/members/diaz'],
    ['a protocol-relative url', '//legislature.example/diaz'],
    ['a url with no scheme', 'legislature.example/diaz'],
    ['text that is not a url', 'not a url'],
  ])('is plain text for %s', async (_label, url) => {
    await renderExpanded([{ name: 'Ana Diaz', vote: 'Yea', url }])
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(document.querySelector('a[href]')).toBeNull()
    expect(screen.getByText('Ana Diaz')).toBeInTheDocument()
  })

  it('links the other voters in the same group', async () => {
    await renderExpanded([
      { name: 'Ana Diaz', vote: 'Yea', url: 'javascript:alert(1)' },
      { name: 'Ben Cole', vote: 'Yea', url: 'https://legislature.example/members/cole' },
    ])
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['Ben Cole'])
  })
})

describe('linked voters across groups', () => {
  it('links each voter in every vote group, including a provider-specific one', async () => {
    await renderExpanded([
      { name: 'Ana Diaz', vote: 'Yes', url: 'https://legislature.example/a' },
      { name: 'Ben Cole', vote: 'No', url: 'https://legislature.example/b' },
      { name: 'Cy Park', vote: 'Present', url: 'https://legislature.example/c' },
    ])
    expect(screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Ana Diaz', 'https://legislature.example/a'],
      ['Ben Cole', 'https://legislature.example/b'],
      ['Cy Park', 'https://legislature.example/c'],
    ])
  })
})
