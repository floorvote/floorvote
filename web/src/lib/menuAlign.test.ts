import { describe, it, expect } from 'vitest'
import { resolveMenuAlign } from './menuAlign'

describe('resolveMenuAlign', () => {
  it('stays left-aligned when the menu fits within the viewport from the trigger', () => {
    // Trigger near the left edge, plenty of room to the right.
    expect(resolveMenuAlign({ left: 20 }, 200, 800)).toBe('left')
  })

  it('flips to right-aligned when left-aligning would overflow the right edge', () => {
    // Trigger near the right edge: left-aligning a 200px-wide menu at x=700
    // would run to x=900, past an 800px-wide viewport.
    expect(resolveMenuAlign({ left: 700 }, 200, 800)).toBe('right')
  })

  it('treats an unmeasured (zero-width) menu as left-aligned — nothing to flip against yet', () => {
    expect(resolveMenuAlign({ left: 700 }, 0, 800)).toBe('left')
  })

  it('respects the viewport margin at the boundary', () => {
    // left(700) + width(92) = 792 = viewportWidth(800) - margin(8): exactly at
    // the boundary, so it should still fit without flipping.
    expect(resolveMenuAlign({ left: 700 }, 92, 800)).toBe('left')
    // One pixel wider tips it over.
    expect(resolveMenuAlign({ left: 700 }, 93, 800)).toBe('right')
  })
})
