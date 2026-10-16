import { describe, it, expect } from 'vitest'
import { splitConfirmText, undoSplitsConfirmText } from './splitConfirm'

// The confirmation before "Split from group" says what the split leaves, from
// GET /bills/:id/split-preview's parts, and claims back only what comes back.

const AFTER = "Each bill's own comments, votes, and team values show on its page again. Notes a member already merged, and values cleared while the bills were grouped, stay as they are."

describe('the split confirmation', () => {
  it('names the one companion the bill leaves', () => {
    expect(splitConfirmText('S1713', [['A190']])).toBe(
      `Split S1713 from its group? It will no longer share a discussion or the team's values with A190. ${AFTER}`)
  })

  it('says the rest stay grouped when their own links join them', () => {
    expect(splitConfirmText('S1713', [['A190', 'S1714']])).toBe(
      `Split S1713 from its group? A190 and S1714 stay grouped with each other. ${AFTER}`)
  })

  it('says the rest come apart when nothing else links them', () => {
    expect(splitConfirmText('S1713', [['A190'], ['S1714']])).toBe(
      `Split S1713 from its group? A190 and S1714 will no longer be grouped with each other either, since nothing else links them. ${AFTER}`)
  })

  it('names each group the rest fall into', () => {
    expect(splitConfirmText('S1713', [['A190', 'A191'], ['S1714']])).toBe(
      `Split S1713 from its group? The rest will come apart, since nothing else links them: A190 and A191 stay grouped, and S1714 will stand alone. ${AFTER}`)
  })
})

// The confirmation before "Group with…" when grouping would undo splits: a split pair grouped again is the
// undo, and it takes every other split between the two groups with it, so it names them all.
describe('the grouping confirmation', () => {
  const pair = (a: string, b: string) => [{ billId: a.toLowerCase(), billNumber: a }, { billId: b.toLowerCase(), billNumber: b }]

  it('names the one split a regrouped pair undoes', () => {
    expect(undoSplitsConfirmText('S1713', 'A190', [pair('A190', 'S1713')])).toBe(
      'Group S1713 with A190? This undoes the split of A190 and S1713.')
  })

  it('counts and names every split, and says why more than the pair\'s own comes back', () => {
    expect(undoSplitsConfirmText('H3000', 'A190', [pair('A190', 'H3000'), pair('H3000', 'S1713')])).toBe(
      'Group H3000 with A190? This undoes 2 splits: A190 and H3000, and H3000 and S1713. Grouping takes back every split between the two bills\' groups, not only the one between H3000 and A190.')
  })

  it('lists three or more with commas', () => {
    expect(undoSplitsConfirmText('H3000', 'A190', [pair('A190', 'H3000'), pair('A191', 'H3000'), pair('H3000', 'S1713')])).toBe(
      'Group H3000 with A190? This undoes 3 splits: A190 and H3000, A191 and H3000, and H3000 and S1713. Grouping takes back every split between the two bills\' groups, not only the one between H3000 and A190.')
  })
})
