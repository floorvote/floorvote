import { describe, it, expect } from 'vitest'
import { computeStickyPushOffset, computeRowOffsets } from './stickyGroupedVirtualList'
import type { StickyVirtualRow } from './stickyGroupedVirtualList'

describe('computeStickyPushOffset', () => {
  const HEADER_HEIGHT = 24

  it('is 0 when the pinned header has not reached its pinning point yet', () => {
    expect(computeStickyPushOffset({
      scrollOffset: 0,
      pinnedHeaderTop: 40, // header hasn't scrolled up to the top yet
      pinnedHeaderHeight: HEADER_HEIGHT,
      nextHeaderTop: 200,
    })).toBe(0)
  })

  it('is 0 when there is no next header to push it out', () => {
    expect(computeStickyPushOffset({
      scrollOffset: 500,
      pinnedHeaderTop: 40,
      pinnedHeaderHeight: HEADER_HEIGHT,
      nextHeaderTop: undefined,
    })).toBe(0)
  })

  it('is 0 while the next header is further away than the pinned header\'s own height', () => {
    // nextHeaderTop - scrollOffset = 300 - 100 = 200, which is >= 24 (not close yet)
    expect(computeStickyPushOffset({
      scrollOffset: 100,
      pinnedHeaderTop: 40,
      pinnedHeaderHeight: HEADER_HEIGHT,
      nextHeaderTop: 300,
    })).toBe(0)
  })

  it('ramps up as the next header arrives within the pinned header\'s height', () => {
    // distance = nextHeaderTop - scrollOffset = 210 - 200 = 10; offset = 24 - 10 = 14
    expect(computeStickyPushOffset({
      scrollOffset: 200,
      pinnedHeaderTop: 40,
      pinnedHeaderHeight: HEADER_HEIGHT,
      nextHeaderTop: 210,
    })).toBe(14)
  })

  it('is fully displaced (offset === height) the instant the next header reaches the top', () => {
    expect(computeStickyPushOffset({
      scrollOffset: 200,
      pinnedHeaderTop: 40,
      pinnedHeaderHeight: HEADER_HEIGHT,
      nextHeaderTop: 200,
    })).toBe(HEADER_HEIGHT)
  })

  it('the offset itself never goes negative (clamped, not merely "small")', () => {
    // distance = nextHeaderTop - scrollOffset = 300 - 100 = 200 >= height -> 0,
    // not a negative "already past" value.
    expect(computeStickyPushOffset({
      scrollOffset: 100,
      pinnedHeaderTop: 40,
      pinnedHeaderHeight: HEADER_HEIGHT,
      nextHeaderTop: 300,
    })).toBeGreaterThanOrEqual(0)
  })
})

describe('computeRowOffsets', () => {
  it('computes cumulative offsets from fixed per-type row heights', () => {
    const rows: StickyVirtualRow[] = [
      { type: 'header', key: 'h1', label: 'NJ' },
      { type: 'option', key: 'o1', value: 'a', label: 'A' },
      { type: 'option', key: 'o2', value: 'b', label: 'B' },
      { type: 'header', key: 'h2', label: 'UT' },
      { type: 'option', key: 'o3', value: 'c', label: 'C' },
    ]
    expect(computeRowOffsets(rows, 24, 32)).toEqual([0, 24, 56, 88, 112])
  })

  it('returns an empty array for no rows', () => {
    expect(computeRowOffsets([], 24, 32)).toEqual([])
  })
})
