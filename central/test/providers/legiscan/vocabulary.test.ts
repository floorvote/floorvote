import { describe, it, expect } from 'vitest'
import { getProvider } from '../../../src/providers'
import { calendarKind } from '../../../src/lib/billCalendar'
import { CALENDAR_KINDS } from '../../../../shared/calendarKinds'

// LegiScan's calendar types: 1 Hearing, 2 Executive Session, 3 Markup Session,
// 10 Deadline. Central reads the kind through calendarKind, which falls back to
// a hearing for a type the vocabulary doesn't list.
const legiscan = getProvider('legiscan')

describe('LegiScan calendar event types', () => {
  it('maps type 10 (Deadline) to the deadline kind, not the hearing fallback', () => {
    expect(calendarKind(legiscan, 10)).toBe('deadline')
  })

  it('labels type 10 Deadline, with a one-sentence explainer', () => {
    const t = legiscan.vocabulary.eventTypes[10]
    expect(t?.label).toBe('Deadline')
    expect(t?.explainer?.trim()).toBeTruthy()
    expect(t?.explainer?.match(/[.!?](\s|$)/g)).toHaveLength(1)
  })

  it('keeps types 1 to 3 as they were', () => {
    expect(calendarKind(legiscan, 1)).toBe('hearing')
    expect(calendarKind(legiscan, 2)).toBe('markup')
    expect(calendarKind(legiscan, 3)).toBe('markup')
    expect(legiscan.vocabulary.eventTypes[1]?.label).toBe('Hearing')
    expect(legiscan.vocabulary.eventTypes[2]?.label).toBe('Executive Session')
    expect(legiscan.vocabulary.eventTypes[3]?.label).toBe('Markup Session')
  })

  it('lists exactly types 1, 2, 3, and 10', () => {
    expect(Object.keys(legiscan.vocabulary.eventTypes).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 10])
  })

  it.each([0, 4, 9, 11, 99, 100])('still falls back to a hearing for unknown type %i', typeId => {
    expect(calendarKind(legiscan, typeId)).toBe('hearing')
  })

  it('still falls back to a hearing when the type is missing', () => {
    expect(calendarKind(legiscan, null)).toBe('hearing')
  })

  it('names a valid calendar kind for every listed type', () => {
    for (const t of Object.values(legiscan.vocabulary.eventTypes)) expect(CALENDAR_KINDS).toContain(t.kind)
  })
})
