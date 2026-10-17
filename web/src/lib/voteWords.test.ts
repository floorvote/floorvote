import { describe, it, expect } from 'vitest'
import { groupVotes, normalizeVoteWord } from './voteWords'

const label = (w: string) => normalizeVoteWord(w).label

describe('normalizeVoteWord: one vocabulary across providers', () => {
  it.each(['Yea', 'Aye', 'Yes', 'yes', 'YEA', ' Yea ', 'Y'])('reads %j as Yea', (w) => expect(label(w)).toBe('Yea'))
  it.each(['Nay', 'No', 'no', 'NAY', ' No ', 'N'])('reads %j as Nay', (w) => expect(label(w)).toBe('Nay'))
  it.each(['NV', 'nv', 'Not Voting', 'not voting', 'Not-Voting', 'Not  Voting'])('reads %j as Not voting', (w) => expect(label(w)).toBe('Not voting'))
  it.each(['Absent', 'absent', 'Excused'])('reads %j as Absent', (w) => expect(label(w)).toBe('Absent'))

  it('maps LegiScan words (Yea, Nay, NV, Absent)', () => {
    expect(['Yea', 'Nay', 'NV', 'Absent'].map(label)).toEqual(['Yea', 'Nay', 'Not voting', 'Absent'])
  })
  it('maps lis words (Yea, Nay, Not Voting, Abstain)', () => {
    expect(['Yea', 'Nay', 'Not Voting', 'Abstain'].map(label)).toEqual(['Yea', 'Nay', 'Not voting', 'Abstain'])
  })
  it('maps lims words (Yes, No, Absent, Present, Recused)', () => {
    expect(['Yes', 'No', 'Absent', 'Present', 'Recused'].map(label)).toEqual(['Yea', 'Nay', 'Absent', 'Present', 'Recused'])
  })

  it('orders Yea, Nay, Not voting, Absent, then everything else', () => {
    const ranks = ['Yea', 'Nay', 'NV', 'Absent'].map((w) => normalizeVoteWord(w).rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(ranks).size).toBe(4)
    for (const w of ['Present', 'Abstain', 'Recused', 'Conflicted']) expect(normalizeVoteWord(w).rank).toBeGreaterThan(Math.max(...ranks))
  })

  it('colors Yea green, Nay red, and every other word neutral', () => {
    expect(normalizeVoteWord('Yes').tone).toBe('yea')
    expect(normalizeVoteWord('No').tone).toBe('nay')
    for (const w of ['NV', 'Absent', 'Present', 'Abstain', 'Recused', 'Conflicted']) expect(normalizeVoteWord(w).tone).toBe('neutral')
  })

  it('shows an unknown word as its own group, as given, and does not drop it', () => {
    const g = normalizeVoteWord('Conflicted')
    expect(g.label).toBe('Conflicted')
    expect(g.tone).toBe('neutral')
    expect(g.key).not.toBe(normalizeVoteWord('Present').key)
  })
  it('keeps an unknown word as given, trimmed, with its original capitalization', () => {
    expect(label('  Voted Present Late ')).toBe('Voted Present Late')
  })
  it('treats the same unknown word in different cases as one group', () => {
    expect(normalizeVoteWord('Conflicted').key).toBe(normalizeVoteWord('conflicted').key)
  })
  it('gives a blank vote word a visible label rather than an empty one', () => {
    expect(label('').length).toBeGreaterThan(0)
    expect(label('   ').length).toBeGreaterThan(0)
  })
  it('gives the same group key to every word of one group', () => {
    expect(normalizeVoteWord('Yes').key).toBe(normalizeVoteWord('Aye').key)
    expect(normalizeVoteWord('Yes').key).not.toBe(normalizeVoteWord('No').key)
  })
})

describe('groupVotes', () => {
  it('groups by normalized word, in the fixed order, keeping each name once in arrival order', () => {
    const groups = groupVotes([
      { name: 'Eve Moss', vote: 'Absent' }, { name: 'Ana Diaz', vote: 'Yes' }, { name: 'Ben Cole', vote: 'No' },
      { name: 'Cy Park', vote: 'NV' }, { name: 'Dee Lane', vote: 'Yea' }, { name: 'Fay Ross', vote: 'Not Voting' },
    ])
    expect(groups.map((g) => [g.group.label, g.names])).toEqual([
      ['Yea', ['Ana Diaz', 'Dee Lane']],
      ['Nay', ['Ben Cole']],
      ['Not voting', ['Cy Park', 'Fay Ross']],
      ['Absent', ['Eve Moss']],
    ])
  })
  it('lists Present, Recused, Abstain and unknown words after the main four, alphabetically', () => {
    const groups = groupVotes([
      { name: 'A', vote: 'Recused' }, { name: 'B', vote: 'Zonked' }, { name: 'C', vote: 'Present' },
      { name: 'D', vote: 'Yes' }, { name: 'E', vote: 'Abstain' },
    ])
    expect(groups.map((g) => g.group.label)).toEqual(['Yea', 'Abstain', 'Present', 'Recused', 'Zonked'])
  })
  it('omits groups with no voters, so the groups cover exactly the votes given', () => {
    const votes = [{ name: 'A', vote: 'Nay' }, { name: 'B', vote: 'Mystery' }]
    const groups = groupVotes(votes)
    expect(groups.map((g) => g.group.label)).toEqual(['Nay', 'Mystery'])
    expect(groups.reduce((n, g) => n + g.names.length, 0)).toBe(votes.length)
  })
  it('returns nothing for no votes', () => expect(groupVotes([])).toEqual([]))
})
