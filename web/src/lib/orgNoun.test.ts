import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ORG_NOUN, normalizeOrgNoun,
  titleCase, orgPositionLabel, orgRelevanceLabel, orgRolesLabel, orgNotificationsLabel,
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
  it('orgRolesLabel', () => {
    expect(orgRolesLabel('chapter')).toBe('Chapter roles')
    expect(orgRolesLabel('team')).toBe('Team roles')
  })
})


describe('orgNotificationsLabel', () => {
  it('capitalizes only the first word', () => {
    expect(orgNotificationsLabel('association')).toBe('Association notifications')
    expect(orgNotificationsLabel('team')).toBe('Team notifications')
  })
  it('falls back to the default noun for missing or empty input', () => {
    expect(orgNotificationsLabel(undefined)).toBe('Team notifications')
    expect(orgNotificationsLabel(null)).toBe('Team notifications')
    expect(orgNotificationsLabel('')).toBe('Team notifications')
    expect(orgNotificationsLabel('!!!')).toBe('Team notifications')
  })
  it('normalizes lowercase, mixed-case, all-caps, and multi-word nouns', () => {
    expect(orgNotificationsLabel('chapter')).toBe('Chapter notifications')
    expect(orgNotificationsLabel('cOaLiTiOn')).toBe('Coalition notifications')
    expect(orgNotificationsLabel('LEAGUE')).toBe('League notifications')
    expect(orgNotificationsLabel('Chapter Office')).toBe('Chapter notifications')
  })
})
