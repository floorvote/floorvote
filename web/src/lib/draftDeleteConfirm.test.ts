import { describe, it, expect } from 'vitest'
import { bulkDraftDeleteConfirm, singleDraftDeleteConfirm, type DraftDeletePreview } from './draftDeleteConfirm'

const preview = (p: Partial<Omit<DraftDeletePreview, 'engagement'>> & { engagement?: Partial<DraftDeletePreview['engagement']> }): DraftDeletePreview => ({
  draftIds: p.draftIds ?? [],
  drafts: p.drafts ?? 1,
  filed: p.filed ?? 0,
  engagedDrafts: p.engagedDrafts ?? 0,
  engagement: { votes: 0, comments: 0, notes: 0, positions: 0, ...p.engagement },
})

describe('singleDraftDeleteConfirm', () => {
  it('says only that it cannot be undone for a draft with no engagement', () => {
    expect(singleDraftDeleteConfirm(preview({}))).toBe("Delete this draft bill? This can't be undone.")
  })

  it('names the engagement that goes with it, in the order votes, comments, notes, positions', () => {
    expect(singleDraftDeleteConfirm(preview({ engagedDrafts: 1, engagement: { votes: 3, comments: 2, notes: 1 } }))).toBe(
      "Delete this draft bill? Your team's 3 votes, 2 comments, and 1 note on it will be deleted too. To keep them, link the draft to its filed bill instead. This can't be undone.",
    )
  })

  it('lists only the kinds there are, joining two with "and"', () => {
    expect(singleDraftDeleteConfirm(preview({ engagedDrafts: 1, engagement: { notes: 2, positions: 1 } }))).toBe(
      "Delete this draft bill? Your team's 2 notes and 1 position on it will be deleted too. To keep them, link the draft to its filed bill instead. This can't be undone.",
    )
  })

  it('says "it" for a single piece of work', () => {
    expect(singleDraftDeleteConfirm(preview({ engagedDrafts: 1, engagement: { votes: 1 } }))).toBe(
      "Delete this draft bill? Your team's 1 vote on it will be deleted too. To keep it, link the draft to its filed bill instead. This can't be undone.",
    )
  })

  it('lists all four kinds with commas and "and"', () => {
    expect(singleDraftDeleteConfirm(preview({ engagedDrafts: 1, engagement: { votes: 1, comments: 1, notes: 1, positions: 1 } }))).toBe(
      "Delete this draft bill? Your team's 1 vote, 1 comment, 1 note, and 1 position on it will be deleted too. To keep them, link the draft to its filed bill instead. This can't be undone.",
    )
  })
})

describe('bulkDraftDeleteConfirm', () => {
  it('counts the drafts when none has engagement', () => {
    expect(bulkDraftDeleteConfirm(preview({ drafts: 5 }))).toBe("Delete 5 draft bills? This can't be undone.")
  })

  it('says how many drafts have work on them and what goes with them', () => {
    expect(bulkDraftDeleteConfirm(preview({ drafts: 5, engagedDrafts: 2, engagement: { votes: 4, comments: 3, positions: 1 } }))).toBe(
      "Delete 5 draft bills? 2 of them have your team's work on them: 4 votes, 3 comments, and 1 position, which will be deleted too. To keep it, link those drafts to their filed bills instead. This can't be undone.",
    )
  })

  it('speaks of one engaged draft in the singular', () => {
    expect(bulkDraftDeleteConfirm(preview({ drafts: 3, engagedDrafts: 1, engagement: { comments: 1 } }))).toBe(
      "Delete 3 draft bills? 1 of them has your team's work on it: 1 comment, which will be deleted too. To keep it, link that draft to its filed bill instead. This can't be undone.",
    )
  })

  it('adds the filed bills a mixed selection leaves alone', () => {
    expect(bulkDraftDeleteConfirm(preview({ drafts: 5, filed: 2 }))).toBe(
      "Delete 5 draft bills? This can't be undone. The 2 filed bills in your selection are not deleted.",
    )
    expect(bulkDraftDeleteConfirm(preview({ drafts: 5, filed: 1, engagedDrafts: 2, engagement: { votes: 4 } }))).toBe(
      "Delete 5 draft bills? 2 of them have your team's work on them: 4 votes, which will be deleted too. To keep it, link those drafts to their filed bills instead. This can't be undone. The 1 filed bill in your selection is not deleted.",
    )
  })

  it('uses the single-draft wording for a selection of one draft', () => {
    expect(bulkDraftDeleteConfirm(preview({ drafts: 1 }))).toBe("Delete this draft bill? This can't be undone.")
    expect(bulkDraftDeleteConfirm(preview({ drafts: 1, filed: 3, engagedDrafts: 1, engagement: { votes: 2 } }))).toBe(
      "Delete this draft bill? Your team's 2 votes on it will be deleted too. To keep them, link the draft to its filed bill instead. This can't be undone. The 3 filed bills in your selection are not deleted.",
    )
  })

  it('formats large counts with separators', () => {
    expect(bulkDraftDeleteConfirm(preview({ drafts: 1000, engagedDrafts: 1000, engagement: { votes: 12345 } }))).toBe(
      "Delete 1,000 draft bills? 1,000 of them have your team's work on them: 12,345 votes, which will be deleted too. To keep it, link those drafts to their filed bills instead. This can't be undone.",
    )
  })
})
