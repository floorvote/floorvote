import { describe, it, expect } from 'vitest'
// sessionToSlug imported via the api re-export — also validates the dedup
// wiring (api/src/lib/sessionSlug re-exports shared). billUrl is shared-only.
import { sessionToSlug } from '../../src/lib/sessionSlug'
import { billUrl } from '../../../shared/sessionSlug'

describe('sessionToSlug', () => {
  it('keeps a two-year regular session range', () => {
    expect(sessionToSlug('2026-2027 Regular Session')).toBe('2026-2027')
  })

  it('extracts a single-year regular session', () => {
    expect(sessionToSlug('2025 Regular Session')).toBe('2025')
  })

  it('encodes a single-year special session as -sN', () => {
    expect(sessionToSlug('2026 1st Special Session')).toBe('2026-s1')
  })

  it('encodes a year-range special session as -sN', () => {
    expect(sessionToSlug('2025-2026 2nd Special Session')).toBe('2025-2026-s2')
  })

  it('matches special sessions before the leading-year rule', () => {
    // The plain "starts with a year" branch would yield "2026"; the special
    // branch must win and produce the -s suffix.
    expect(sessionToSlug('2026 3rd Special Session')).toBe('2026-s3')
  })

  it('falls back to a kebab slug when there is no leading year', () => {
    expect(sessionToSlug('Special Joint Session')).toBe('special-joint-session')
  })
})

describe('billUrl', () => {
  it('builds the canonical /STATE/SLUG/BILL path and uppercases state', () => {
    expect(billUrl({ state: 'ri', sessionSlug: '2026', billNumber: 'HB0209' }))
      .toBe('/RI/2026/HB0209')
  })

  it('derives the slug from a raw session name when no sessionSlug given', () => {
    expect(billUrl({ state: 'RI', session: '2026-2027 Regular Session', billNumber: 'H 100' }))
      .toBe('/RI/2026-2027/H 100')
  })

  it('prefers sessionSlug over session when both are present', () => {
    expect(billUrl({ state: 'RI', sessionSlug: '2026', session: 'ignored', billNumber: 'X' }))
      .toBe('/RI/2026/X')
  })

  it('falls back to /bills/:id when state is missing but id is known', () => {
    expect(billUrl({ sessionSlug: '2026', billNumber: 'HB1', id: 'abc' }))
      .toBe('/bills/abc')
  })

  it('falls back to /SLUG/BILL when state and id are both missing', () => {
    expect(billUrl({ sessionSlug: '2026', billNumber: 'HB1' }))
      .toBe('/2026/HB1')
  })

  it('returns "#" when there is no slug, state, or id to build a link', () => {
    expect(billUrl({ billNumber: 'HB1' })).toBe('#')
  })
})
