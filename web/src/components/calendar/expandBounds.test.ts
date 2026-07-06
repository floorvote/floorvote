import { describe, it, expect } from 'vitest'
import { clampTargetFor } from './expandBounds'

const rect = { left: 100, top: 100, width: 120, height: 46 } as DOMRect

describe('clampTargetFor', () => {
  it('returns null when the element is null', () => {
    expect(clampTargetFor(null, rect)).toBeNull()
  })

  it('returns null when the element is not inside a calendar grid', () => {
    const el = document.createElement('div') // detached: no [data-calgrid] ancestor
    expect(clampTargetFor(el, rect)).toBeNull()
  })

  it('returns a function when inside a calendar grid cell', () => {
    const grid = document.createElement('div')
    grid.setAttribute('data-calgrid', '')
    const cell = document.createElement('div')
    cell.setAttribute('data-daycell', '2026-06-09')
    cell.setAttribute('data-inmonth', '1')
    const anchor = document.createElement('button')
    cell.appendChild(anchor)
    grid.appendChild(cell)
    document.body.appendChild(grid)
    try {
      const fn = clampTargetFor(anchor, rect)
      expect(fn).not.toBeNull()
      const box = fn!(120)
      expect(typeof box.left).toBe('number')
      expect(typeof box.top).toBe('number')
      expect(typeof box.width).toBe('number')
      expect(box.height).toBe(120) // naturalHeight passes through
    } finally {
      document.body.removeChild(grid)
    }
  })
})
