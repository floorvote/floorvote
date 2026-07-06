import { describe, it, expect, vi, afterEach } from 'vitest'
import { detectCalendarChanges, calendarIdentityKey, type PriorCalendarRow } from './detect-changes'
import type { LegiscanCalendarEntry } from './legiscan'

const TODAY = '2026-06-05'

function entry(o: Partial<LegiscanCalendarEntry> & { description: string }): LegiscanCalendarEntry {
  return {
    type_id: o.type_id ?? 1,
    type: o.type ?? 'Hearing',
    date: o.date ?? '2026-06-10',
    time: o.time ?? '10:00',
    location: o.location ?? 'Room 100',
    description: o.description,
    event_hash: o.event_hash ?? 'hash-new',
  }
}

function prior(o: { description: string; date: string; eventHash: string | null; time?: string | null; location?: string | null }): PriorCalendarRow {
  return {
    identityKey: calendarIdentityKey({ type_id: 1, description: o.description, date: o.date }),
    eventHash: o.eventHash,
    date: o.date,
    description: o.description,
    time: o.time ?? null,
    location: o.location ?? null,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('detectCalendarChanges — past-hearing suppression', () => {
  it('suppresses hearing_changed for a hearing whose date is in the past', () => {
    const priors = [prior({ description: 'Approps', date: '2026-04-27', eventHash: 'h1' })]
    const incoming = [entry({ description: 'Approps', date: '2026-04-27', event_hash: 'h2' })]
    const changes = detectCalendarChanges(priors, incoming, TODAY)
    expect(changes.find(c => c.changeType === 'hearing_changed')).toBeUndefined()
  })

  it('keeps hearing_changed for a future hearing', () => {
    const priors = [prior({ description: 'Approps', date: '2026-12-01', eventHash: 'h1' })]
    const incoming = [entry({ description: 'Approps', date: '2026-12-01', event_hash: 'h2' })]
    const changes = detectCalendarChanges(priors, incoming, TODAY)
    expect(changes.find(c => c.changeType === 'hearing_changed')).toBeDefined()
  })

  it('suppresses hearing_cancelled for a past hearing', () => {
    const priors = [prior({ description: 'Old hearing', date: '2026-01-15', eventHash: 'h1' })]
    const incoming: LegiscanCalendarEntry[] = []
    const changes = detectCalendarChanges(priors, incoming, TODAY)
    expect(changes.find(c => c.changeType === 'hearing_cancelled')).toBeUndefined()
  })

  it('keeps hearing_cancelled for a future hearing', () => {
    const priors = [prior({ description: 'Future hearing', date: '2026-09-01', eventHash: 'h1' })]
    const incoming: LegiscanCalendarEntry[] = []
    const changes = detectCalendarChanges(priors, incoming, TODAY)
    expect(changes.find(c => c.changeType === 'hearing_cancelled')).toBeDefined()
  })

  it('does NOT suppress hearing_added even when the date is in the past', () => {
    const incoming = [entry({ description: 'Back-dated add', date: '2026-02-01', event_hash: 'h2' })]
    const changes = detectCalendarChanges([], incoming, TODAY)
    expect(changes.find(c => c.changeType === 'hearing_added')).toBeDefined()
  })

  it('keeps changes with a null date (cannot determine past)', () => {
    const priors = [prior({ description: 'No date', date: '', eventHash: 'h1' })]
    const incoming = [entry({ description: 'No date', date: '', event_hash: 'h2' })]
    const changes = detectCalendarChanges(priors, incoming, TODAY)
    expect(changes.find(c => c.changeType === 'hearing_changed')).toBeDefined()
  })
})

describe('detectCalendarChanges — diagnostic logging', () => {
  it('logs a structured line when a hearing_changed is detected (incl. suppressed past ones)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priors = [prior({ description: 'Approps', date: '2026-04-27', eventHash: 'h1', time: '09:00', location: 'Room 1' })]
    const incoming = [entry({ description: 'Approps', date: '2026-04-27', time: '10:00', location: 'Room 2', event_hash: 'h2' })]
    detectCalendarChanges(priors, incoming, TODAY)
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain('[calendar-change]')
    expect(logged).toContain('h1')
    expect(logged).toContain('h2')
  })
})
