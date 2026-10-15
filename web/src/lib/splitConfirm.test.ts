import { describe, it, expect } from 'vitest'
import { splitConfirmText } from './splitConfirm'

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
