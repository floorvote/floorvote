import { describe, it, expect } from 'vitest'
import { isProceduralCommittee } from './committees'

// A procedural committee routes or schedules bills rather than weighing what they say (Rules, Assignments,
// Calendars), so it can touch half a session's bills. The Committee filter lists them last, tagged.
describe('isProceduralCommittee', () => {
  it.each([
    'Rules', 'House Rules', 'Senate Rules and Administration', 'Assignments', 'Committee on Assignments',
    'Calendars', 'Calendar', 'Reference', 'Committee on Committees', 'Committee of the Whole',
  ])('calls %s procedural', name => {
    expect(isProceduralCommittee(name)).toBe(true)
  })

  it.each([
    'Judiciary', 'Ways and Means', 'Appropriations', 'Natural Resources', 'Elections and Ethics', 'Administrative Rules Review',
  ])('calls %s substantive', name => {
    expect(isProceduralCommittee(name)).toBe(false)
  })
})
