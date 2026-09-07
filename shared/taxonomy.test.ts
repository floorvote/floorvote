import { describe, it, expect } from 'vitest'
import { DEFAULT_TAXONOMY, serializeTaxonomy } from './taxonomy'
import { parseTagTaxonomy } from '../web/src/pages/admin/aiConfig'

describe('serializeTaxonomy', () => {
  it('renders a bare name on its own', () => {
    expect(serializeTaxonomy([{ name: 'Elections' }])).toBe('Elections')
  })

  it('renders a described entry as "Name: description"', () => {
    expect(serializeTaxonomy([{ name: 'Elections', description: 'voting and registration' }]))
      .toBe('Elections: voting and registration')
  })

  it('separates entries with a blank line', () => {
    expect(serializeTaxonomy([{ name: 'A' }, { name: 'B' }])).toBe('A\n\nB')
  })

  it('renders an empty list as an empty string', () => {
    expect(serializeTaxonomy([])).toBe('')
  })

  it('round-trips through the editor parser', () => {
    const items = [
      { name: 'Elections', description: 'voting and registration' },
      { name: 'Local Government' },
    ]
    expect(parseTagTaxonomy(serializeTaxonomy(items))).toEqual({ ok: true, value: items })
  })

  it('round-trips the default taxonomy', () => {
    expect(parseTagTaxonomy(serializeTaxonomy(DEFAULT_TAXONOMY)))
      .toEqual({ ok: true, value: DEFAULT_TAXONOMY })
  })
})
