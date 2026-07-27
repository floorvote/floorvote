import { describe, it, expect } from 'vitest'
import { eventSourceIcon } from '../../../shared/eventLineModel'
import { color } from '../../../shared/tokens'

describe('eventSourceIcon', () => {
  it('maps data-pulled hearings to gavel + navy', () => {
    const r = eventSourceIcon({ source: 'legiscan' })
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
})
