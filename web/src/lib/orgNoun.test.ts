import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ORG_NOUN, normalizeOrgNoun,
  titleCase, orgPositionLabel, orgRelevanceLabel,
} from './orgNoun'

describe('normalizeOrgNoun', () => {
  it('takes the first word, lowercased', () => {
    expect(normalizeOrgNoun('Association')).toBe('association')
    expect(normalizeOrgNoun('Association position')).toBe('association')
    expect(normalizeOrgNoun('  Coalition  ')).toBe('coalition')
  })
  it('defaults to team for empty/missing', () => {
    expect(DEFAULT_ORG_NOUN).toBe('team')
    expect(normalizeOrgNoun('')).toBe(DEFAULT_ORG_NOUN)
    expect(normalizeOrgNoun(null)).toBe(DEFAULT_ORG_NOUN)
    expect(normalizeOrgNoun(undefined)).toBe(DEFAULT_ORG_NOUN)
  })
  it('strips non-letter characters from the noun', () => {
    expect(normalizeOrgNoun('Team#1!')).toBe('team')
    expect(normalizeOrgNoun('a&b')).toBe('ab')
    expect(normalizeOrgNoun('<script>')).toBe('script')
    expect(normalizeOrgNoun('co-op')).toBe('coop')
    expect(normalizeOrgNoun('league2024')).toBe('league')
  })
  it('falls back to team when only junk is supplied', () => {
    expect(normalizeOrgNoun('123 456')).toBe(DEFAULT_ORG_NOUN)
    expect(normalizeOrgNoun('!!!')).toBe(DEFAULT_ORG_NOUN)
  })
  it('caps length at 32 characters', () => {
    const long = 'a'.repeat(50)
    expect(normalizeOrgNoun(long)).toBe('a'.repeat(32))
    expect(normalizeOrgNoun(long).length).toBe(32)
  })
})

describe('display helpers', () => {
  it('titleCase', () => {
    expect(titleCase('association')).toBe('Association')
    expect(titleCase('')).toBe('')
  })
  it('orgPositionLabel', () => {
    expect(orgPositionLabel('association')).toBe('Association position')
    expect(orgPositionLabel('team')).toBe('Team position')
  })
  it('orgRelevanceLabel', () => {
    expect(orgRelevanceLabel('coalition')).toBe('Coalition relevance')
  })
})

