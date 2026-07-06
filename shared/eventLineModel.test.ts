import { describe, it, expect } from 'vitest'
import { formatEventUrl, eventBodyModel, EVENT_CARD_BASE, type EventForBodyModel } from './eventLineModel'
import { CARD_STYLE } from './billCardModel'
import { radius } from './tokens'

describe('EVENT_CARD_BASE chrome matches Feed card', () => {
  it('uses radius.lg, gap 8, and Feed resting shadow', () => {
    expect(EVENT_CARD_BASE.borderRadius).toBe(radius.lg)
    expect(EVENT_CARD_BASE.marginBottom).toBe(8)
    expect(EVENT_CARD_BASE.boxShadow).toBe(CARD_STYLE.shadow)
  })
})

describe('formatEventUrl', () => {
  it('drops https:// and a leading www.', () => {
    expect(formatEventUrl('https://www.rilegislature.gov/hearings')).toBe('rilegislature.gov/hearings')
  })
  it('drops http:// and a trailing slash', () => {
    expect(formatEventUrl('http://example.com/')).toBe('example.com')
  })
  it('keeps non-www subdomains', () => {
    expect(formatEventUrl('https://sub.example.com/x')).toBe('sub.example.com/x')
  })
  it('passes through a URL with no scheme', () => {
    expect(formatEventUrl('example.com/y')).toBe('example.com/y')
  })
  it('trims surrounding whitespace', () => {
    expect(formatEventUrl('  https://www.x.org/a  ')).toBe('x.org/a')
  })
})

const base: EventForBodyModel = {
  description: null, location: null, bills: [], time: null, status: null,
}

describe('eventBodyModel — full variant', () => {
  it('uses the description as the title', () => {
    const m = eventBodyModel({ ...base, description: 'House Elections Committee', location: 'Room 101' }, false)
    expect(m.text).toBe('House Elections Committee')
    expect(m.location).toBe('Room 101')
  })
  it('falls back to the first bill title (not the location) when there is no description', () => {
    const m = eventBodyModel({ ...base, location: 'Room 101', bills: [{ billTitle: 'Voter ID Act' }] }, false)
    expect(m.text).toBe('Voter ID Act')
    expect(m.location).toBe('Room 101')
  })
  it('falls back to "Hearing" when there is no description or bill title', () => {
    const m = eventBodyModel({ ...base, location: 'Room 101' }, false)
    expect(m.text).toBe('Hearing')
  })
  it('always returns the location on its own line when present', () => {
    const m = eventBodyModel({ ...base, description: 'X', location: 'Senate Lounge' }, false)
    expect(m.location).toBe('Senate Lounge')
  })
})

describe('eventBodyModel — compact variant is unchanged', () => {
  it('keeps the location title fallback and never sets a location line', () => {
    const m = eventBodyModel({ ...base, location: 'Room 101' }, true)
    expect(m.text).toBe('Room 101')
    expect(m.location).toBeNull()
  })
})
