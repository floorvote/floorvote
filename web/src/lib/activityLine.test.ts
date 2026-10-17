import { describe, it, expect } from 'vitest'
import type { FieldChangeEvent } from '../../../shared/teamFields'
import { fieldChangeText, foldText } from './activityLine'

// The sentence an activity line in a bill's comment thread reads, for each
// kind of team field change: priority, position, a custom field, and tags.
const change = (over: Partial<FieldChangeEvent>): FieldChangeEvent => ({
  id: 'e', createdAt: '2026-10-14 12:00:00', actorId: 'u1', actorName: 'David Park', billId: 'a190', billNumber: 'A190',
  field: 'priority', label: 'priority', old: null, new: null, ...over,
})

describe('fieldChangeText', () => {
  describe('priority', () => {
    it('says what it changed from and to, capitalizing the stored value', () => {
      expect(fieldChangeText(change({ old: 'medium', new: 'high' }))).toBe('David Park changed priority from Medium to High')
    })

    it('says it set a priority that had none', () => {
      expect(fieldChangeText(change({ old: null, new: 'low' }))).toBe('David Park set priority to Low')
    })

    it('says it cleared a priority, naming what it was', () => {
      expect(fieldChangeText(change({ old: 'high', new: null }))).toBe('David Park cleared priority (was High)')
    })
  })

  describe('official position', () => {
    const position = (over: Partial<FieldChangeEvent>) => change({ field: 'position', label: 'position', ...over })

    it('says what it changed from and to, as the position was worded when set', () => {
      expect(fieldChangeText(position({ old: 'Support', new: 'Oppose' }))).toBe('David Park changed the official position from Support to Oppose')
    })

    it('says it set and cleared a position', () => {
      expect(fieldChangeText(position({ old: null, new: 'Amend' }))).toBe('David Park set the official position to Amend')
      expect(fieldChangeText(position({ old: 'Amend', new: null }))).toBe('David Park cleared the official position (was Amend)')
    })

    it("calls the position what the page calls it, when told the page's label", () => {
      expect(fieldChangeText(position({ old: null, new: 'Support' }), { positionLabel: 'association position' }))
        .toBe('David Park set the association position to Support')
    })
  })

  describe('a custom field', () => {
    const field = (over: Partial<FieldChangeEvent>) => change({ field: 'customField', fieldId: 'cf1', label: 'Committee lead', fieldType: 'text', ...over })

    it("names the field and puts its values in quotes, so a value with spaces reads as one", () => {
      expect(fieldChangeText(field({ old: null, new: 'Policy team' }))).toBe('David Park set Committee lead to "Policy team"')
      expect(fieldChangeText(field({ old: 'Policy team', new: 'Legal' }))).toBe('David Park changed Committee lead from "Policy team" to "Legal"')
      expect(fieldChangeText(field({ old: 'Legal', new: null }))).toBe('David Park cleared Committee lead (was "Legal")')
    })

    it('lists the choices of a multi-select, stored as a JSON array', () => {
      expect(fieldChangeText(field({ fieldType: 'dropdown', old: '["Energy"]', new: '["Energy","Labor"]' })))
        .toBe('David Park changed Committee lead from "Energy" to "Energy, Labor"')
    })

    it('reads a checked yes/no field as Yes', () => {
      expect(fieldChangeText(field({ label: 'Urgent', fieldType: 'binary', old: null, new: '1' }))).toBe('David Park set Urgent to "Yes"')
      expect(fieldChangeText(field({ label: 'Urgent', fieldType: 'binary', old: '1', new: null }))).toBe('David Park cleared Urgent (was "Yes")')
    })

    it('cuts a long text value short', () => {
      const long = 'x'.repeat(100)
      const text = fieldChangeText(field({ old: null, new: long }))
      expect(text.length).toBeLessThan(100)
      expect(text).toMatch(/^David Park set Committee lead to "x+…"$/)
    })

    it('reads an empty value as cleared', () => {
      expect(fieldChangeText(field({ old: 'Legal', new: '' }))).toBe('David Park cleared Committee lead (was "Legal")')
    })

    it('reads a field whose definition is gone by the name it had', () => {
      expect(fieldChangeText(field({ label: 'Old committee', fieldType: undefined, old: null, new: 'Labor' }))).toBe('David Park set Old committee to "Labor"')
    })
  })

  describe('tags', () => {
    const tags = (over: Partial<FieldChangeEvent>) => change({ field: 'tags', label: 'tags', ...over })

    it('lists the tags it added', () => {
      expect(fieldChangeText(tags({ old: [], new: ['Energy'] }))).toBe('David Park added the tag Energy')
      expect(fieldChangeText(tags({ old: [], new: ['Energy', 'Labor'] }))).toBe('David Park added the tags Energy and Labor')
      expect(fieldChangeText(tags({ old: [], new: ['Energy', 'Labor', 'Health care'] }))).toBe('David Park added the tags Energy, Labor, and Health care')
    })

    it('lists the tags it removed', () => {
      expect(fieldChangeText(tags({ old: ['Energy', 'Labor'], new: ['Energy'] }))).toBe('David Park removed the tag Labor')
      expect(fieldChangeText(tags({ old: ['Energy', 'Labor'], new: [] }))).toBe('David Park removed the tags Energy and Labor')
    })

    it('says both when it added some and removed others, and leaves the tags that stayed out', () => {
      expect(fieldChangeText(tags({ old: ['Energy', 'Labor'], new: ['Energy', 'Housing'] }))).toBe('David Park added the tag Housing and removed the tag Labor')
    })

    it('reads a null old or new list as empty', () => {
      expect(fieldChangeText(tags({ old: null, new: ['Energy'] }))).toBe('David Park added the tag Energy')
      expect(fieldChangeText(tags({ old: ['Energy'], new: null }))).toBe('David Park removed the tag Energy')
    })
  })

  it('names FloorVote when the change has no actor', () => {
    expect(fieldChangeText(change({ actorName: null, actorId: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] }))).toBe('FloorVote added the tag Energy')
  })
})

describe('foldText', () => {
  it('counts the changes and names who made them', () => {
    expect(foldText('David Park', 3)).toBe('3 changes by David Park')
    expect(foldText('David Park', 2)).toBe('2 changes by David Park')
  })

  it('names FloorVote for changes with no actor', () => {
    expect(foldText(null, 4)).toBe('4 changes by FloorVote')
  })
})
