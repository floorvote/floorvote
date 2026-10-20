import { describe, it, expect } from 'vitest'
import { JUST_CREATED_DRAFT_KEY, justCreatedDraftState, isJustCreatedDraft } from './justCreatedDraft'

describe('just-created-draft router state', () => {
  it('is recognized when it is the state the creator hands to navigate()', () => {
    expect(isJustCreatedDraft(justCreatedDraftState())).toBe(true)
  })

  it('is keyed by the one exported key', () => {
    expect(justCreatedDraftState()).toEqual({ [JUST_CREATED_DRAFT_KEY]: true })
  })

  it('is not recognized on an ordinary visit, where location.state is null', () => {
    expect(isJustCreatedDraft(null)).toBe(false)
    expect(isJustCreatedDraft(undefined)).toBe(false)
  })

  it('is not recognized in unrelated router state', () => {
    expect(isJustCreatedDraft({ from: '/bills' })).toBe(false)
    expect(isJustCreatedDraft('justCreatedDraft')).toBe(false)
  })

  it('requires the flag to be exactly true', () => {
    expect(isJustCreatedDraft({ justCreatedDraft: false })).toBe(false)
    expect(isJustCreatedDraft({ justCreatedDraft: 'yes' })).toBe(false)
  })
})
