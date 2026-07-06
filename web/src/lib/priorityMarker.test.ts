import { describe, it, expect } from 'vitest'
import { priorityMarkerSpec, prioritySquareRadius, PRIORITY_MARKER_RING } from '../../../shared/priorityMarker'
import { PRIORITY_COLORS } from '../../../shared/billChipColors'

describe('prioritySquareRadius', () => {
  it('is ~1/5 of the side, floored at 2px', () => {
    expect(prioritySquareRadius(9)).toBe(2)   // round(1.8)=2
    expect(prioritySquareRadius(11)).toBe(2)  // round(2.2)=2
    expect(prioritySquareRadius(20)).toBe(4)
    expect(prioritySquareRadius(4)).toBe(2)   // floored
  })
})

describe('priorityMarkerSpec', () => {
  it('resolves fill from PRIORITY_COLORS per level', () => {
    expect(priorityMarkerSpec('high', { size: 9, ring: true }).fill).toBe(PRIORITY_COLORS.high.dot)
    expect(priorityMarkerSpec('low', { size: 9, ring: false }).fill).toBe(PRIORITY_COLORS.low.dot)
  })

  it('toggles the ring halo', () => {
    expect(priorityMarkerSpec('high', { size: 9, ring: true }).ring).toBe(PRIORITY_MARKER_RING)
    expect(priorityMarkerSpec('high', { size: 9, ring: false }).ring).toBeNull()
  })

  it('carries size through and derives radius', () => {
    const m = priorityMarkerSpec('medium', { size: 11, ring: true })
    expect(m.size).toBe(11)
    expect(m.radius).toBe(prioritySquareRadius(11))
  })
})
