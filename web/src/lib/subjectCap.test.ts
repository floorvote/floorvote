import { describe, it, expect } from 'vitest'
import { MAX_SUBJECT_FILTERS } from '../../../shared/limits'
import { isSubjectCapReached, subjectCapHint } from './subjectCap'

describe('subject cap helpers', () => {
  it('reads the cap from the one shared constant', () => {
    expect(MAX_SUBJECT_FILTERS).toBe(40)
  })

  it('is not reached one below the cap, reached at it and past it', () => {
    expect(isSubjectCapReached(0)).toBe(false)
    expect(isSubjectCapReached(MAX_SUBJECT_FILTERS - 1)).toBe(false)
    expect(isSubjectCapReached(MAX_SUBJECT_FILTERS)).toBe(true)
    expect(isSubjectCapReached(MAX_SUBJECT_FILTERS + 5)).toBe(true)
  })

  it('says why at the cap', () => {
    expect(subjectCapHint(MAX_SUBJECT_FILTERS)).toBe('You can pick up to 40 subjects.')
  })

  it('says how many to remove when a saved view or link is already over the cap', () => {
    expect(subjectCapHint(MAX_SUBJECT_FILTERS + 3)).toBe(
      'You can pick up to 40 subjects. This filter has 43. Remove 3 to continue.',
    )
  })
})
