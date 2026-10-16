import { describe, it, expect } from 'vitest'
import { eventSourceIcon } from '../../../shared/eventLineModel'
import { color } from '../../../shared/tokens'
import { canEditEventSource } from '../../../shared/eventSource'

describe('eventSourceIcon', () => {
  it('maps data-pulled hearings to gavel + navy', () => {
    const r = eventSourceIcon({ source: 'hearing' })
    expect(r.icon).toBe('gavel')
    expect(r.color).toBe(color.billBadgeNavy)
    expect(r.tint).toBe(color.bgInfo)
  })
  it('maps custom events to calendar_today + blue', () => {
    const r = eventSourceIcon({ source: 'custom' })
    expect(r.icon).toBe('calendar_today')
    expect(r.color).toBe(color.accentBlue)
    expect(r.tint).toBe(color.bgInfo)
  })
  it('maps a bill\'s deadline to a clock in amber', () => {
    expect(eventSourceIcon({ source: 'hearing', kind: 'deadline' })).toEqual({
      icon: 'schedule', color: color.textAmberDark, tint: color.bgAmberPriority, label: 'Deadline',
    })
  })
  it('labels other synced events by kind', () => {
    expect(eventSourceIcon({ source: 'body', kind: 'markup' })).toMatchObject({ icon: 'gavel', label: 'Markup' })
    expect(eventSourceIcon({ source: 'body', kind: 'hearing' })).toMatchObject({ icon: 'gavel', label: 'Hearing' })
  })
  it('maps a date-field event to the event glyph in the custom-event color, labeled by its field', () => {
    const custom = eventSourceIcon({ source: 'custom' })
    expect(eventSourceIcon({ source: 'field', fieldName: 'Comment deadline' })).toEqual({
      icon: 'event', color: custom.color, tint: custom.tint, label: 'Comment deadline',
    })
  })
})

describe('canEditEventSource', () => {
  it('lets only a custom event be edited, cancelled, or deleted', () => {
    expect(canEditEventSource('custom')).toBe(true)
    for (const s of ['hearing', 'body', 'council', 'field'] as const) expect(canEditEventSource(s), s).toBe(false)
  })
})
