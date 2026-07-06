// web/src/components/calendar/expandTarget.test.ts
import { describe, it, expect } from 'vitest'
import { computeExpandTarget, type ExpandInputs } from './expandTarget'

// A calendar grid spanning x:[200,1200], y:[100,1000]; active weeks end at 900.
// pad = 7 (event inset inside a cell). Default expanded width = 320.
const base: ExpandInputs = {
  card: { left: 250, top: 150, width: 130, height: 46 },
  calLeft: 200, calRight: 1200, calTop: 100, activeBottom: 900, pad: 7,
}

describe('computeExpandTarget', () => {
  it('grows rightward from the card left when there is room', () => {
    const box = computeExpandTarget(base, 90)
    expect(box.left).toBe(250)        // unchanged
    expect(box.width).toBe(320)
    expect(box.top).toBe(150)         // title anchored
    expect(box.height).toBe(90)
  })

  it('pins the right edge to (calRight - pad) near the right edge, growing left', () => {
    const card = { left: 1000, top: 150, width: 130, height: 46 } // 1000+320 > 1200-7
    const box = computeExpandTarget({ ...base, card }, 90)
    expect(box.left).toBe(1200 - 7 - 320) // 873
    expect(box.left + box.width).toBe(1200 - 7) // 7px gap to calendar right
  })

  it('clamps the bottom to (activeBottom - pad), lifting top when needed', () => {
    const card = { left: 250, top: 850, width: 130, height: 46 } // 850+120 > 900-7
    const box = computeExpandTarget({ ...base, card }, 120)
    expect(box.top).toBe(900 - 7 - 120)   // 773
    expect(box.top + box.height).toBe(900 - 7) // 7px gap to active-weeks bottom
  })

  it('never returns top above calTop', () => {
    const small = { ...base, calTop: 100, activeBottom: 160 }
    const card = { left: 250, top: 140, width: 130, height: 46 }
    const box = computeExpandTarget({ ...small, card }, 300) // taller than the whole area
    expect(box.top).toBe(100) // clamped to calTop
  })

  it('never returns left below calLeft', () => {
    const narrow = { ...base, calLeft: 200, calRight: 500 } // width 320 > 300-pad
    const card = { left: 480, top: 150, width: 15, height: 46 }
    const box = computeExpandTarget({ ...narrow, card }, 90)
    expect(box.left).toBe(200) // clamped to calLeft
  })

  it('respects a custom width', () => {
    const box = computeExpandTarget({ ...base, width: 280 }, 90)
    expect(box.width).toBe(280)
  })
})
